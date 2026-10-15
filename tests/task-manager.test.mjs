import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskManager } from '../src/main/task-manager.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await sleep(10)
  }
  assert.fail('等待状态更新超时')
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mod-queue-'))
  const historyPath = join(dir, 'history.json')
  const records = new Map()
  let failureHandler
  let launchError = null
  let sequence = 0
  const driver = {
    setFailureHandler(fn) {
      failureHandler = fn
    },
    async ensure() {
      if (launchError) throw launchError
    },
    async add(task) {
      const gid = String(++sequence)
      records.set(gid, {
        id: task.id,
        status: 'active',
        completedLength: '128',
        totalLength: '1024',
        downloadSpeed: '64',
        connections: '1',
        files: [{ path: join(task.dir, task.filename) }]
      })
      return gid
    },
    async status(gid) {
      if (!records.has(gid)) throw new Error('引擎断开')
      return records.get(gid)
    },
    async pause(gid) {
      records.get(gid).status = 'paused'
      return records.get(gid)
    },
    async resume(gid) {
      records.get(gid).status = 'active'
    },
    async remove(gid) {
      records.delete(gid)
    },
    async destroy() {
      records.clear()
    }
  }
  const manager = createTaskManager({ driver, historyPath, pollMs: 10, saveMs: 40, ...options })
  t.after(() => manager.destroy())
  const payload = (n, extra = {}) => ({
    url: `https://example.com/${n}.zip`,
    dir,
    filename: `${n}.zip`,
    connections: 1,
    ...extra
  })
  const add = async (n, extra) => {
    await manager.add(payload(n, extra))
    return manager.list().tasks.at(-1).id
  }
  const task = (id) => manager.list().tasks.find((item) => item.id === id)
  const complete = (id) => {
    const raw = [...records.values()].find((item) => item.id === id)
    Object.assign(raw, { status: 'complete', completedLength: '1024' })
  }
  return {
    manager,
    driver,
    records,
    dir,
    historyPath,
    payload,
    add,
    task,
    complete,
    fail: () => failureHandler(new Error('引擎意外退出')),
    launchError: (error) => {
      launchError = error
    }
  }
}

test('五个任务按容量排队，暂停/取消/完成补位，进度不归零', async (t) => {
  const f = fixture(t)
  const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => f.add(n)))
  assert.deepEqual(
    f.manager.list().tasks.map((task) => task.status),
    ['active', 'active', 'waiting', 'waiting', 'waiting']
  )
  await f.manager.pause(ids[0])
  assert.equal(f.task(ids[0]).status, 'paused')
  assert.equal(f.task(ids[0]).completedLength, 128)
  assert.equal(f.task(ids[2]).status, 'active')
  await f.manager.resume(ids[0])
  assert.equal(f.task(ids[0]).status, 'waiting')
  await f.manager.cancel(ids[1])
  assert.equal(f.task(ids[3]).status, 'active')
  f.complete(ids[2])
  await until(() => f.task(ids[4]).status === 'active')
  assert.equal(f.task(ids[2]).percent, 100)
  await f.manager.cancel(ids[3])
  assert.equal(f.task(ids[0]).status, 'active')
})

test('降低并发不打断下载；快速重复继续不会重复创建任务', async (t) => {
  const f = fixture(t)
  const a = await f.add('a'),
    b = await f.add('b'),
    c = await f.add('c')
  await f.manager.setConcurrency(1)
  assert.equal(f.task(a).status, 'active')
  assert.equal(f.task(b).status, 'active')
  await f.manager.cancel(a)
  assert.equal(f.task(c).status, 'waiting')
  await f.manager.pause(b)
  assert.equal(f.task(c).status, 'active')
  await Promise.all([f.manager.resume(b), f.manager.resume(b), f.manager.resume(b)])
  assert.equal(f.task(b).status, 'waiting')
  await f.manager.setConcurrency(2)
  assert.equal(f.task(b).status, 'active')
  assert.equal(f.records.size, 2)
  await assert.rejects(f.manager.setConcurrency(6))
})

test('历史恢复保留 ID、进度、终态和并发；任务文件不保存 Cookie', async (t) => {
  const f = fixture(t)
  const a = await f.add('a', { cookie: 'private=secret-cookie' })
  const b = await f.add('b')
  const c = await f.add('c')
  f.complete(b)
  await until(() => f.task(b).status === 'complete')
  await f.manager.cancel(c)
  await f.manager.setConcurrency(3)
  await until(() => f.task(a).completedLength === 128)
  await f.manager.destroy()
  assert.equal(readFileSync(f.historyPath, 'utf8').includes('secret-cookie'), false)
  const restored = createTaskManager({
    driver: f.driver,
    historyPath: f.historyPath,
    pollMs: 10000
  })
  t.after(() => restored.destroy())
  const tasks = restored.list().tasks
  assert.equal(restored.list().maxConcurrent, 3)
  assert.equal(tasks[0].id, a)
  assert.equal(tasks[0].completedLength, 128)
  assert.equal(tasks[0].status, 'paused')
  assert.equal(tasks[0].downloadSpeed, 0)
  assert.equal(tasks[1].status, 'complete')
  assert.equal(tasks[2].status, 'cancelled')
  await assert.rejects(restored.resume(a), /Cookie/)
  await assert.rejects(restored.resume(a, f.payload('a')), /Cookie/)
  await restored.resume(a, f.payload('a', { cookie: 'replacement=ok' }))
  assert.equal(restored.list().tasks[0].status, 'active')
  assert.equal(readFileSync(f.historyPath, 'utf8').includes('replacement=ok'), false)
})

test('任务失败不阻塞队列，引擎退出停止调度，重试可恢复', async (t) => {
  const f = fixture(t)
  const a = await f.add('a'),
    b = await f.add('b'),
    c = await f.add('c')
  Object.assign([...f.records.values()][0], { status: 'error', errorMessage: '404' })
  await until(() => f.task(c).status === 'active')
  assert.equal(f.task(a).errorMessage, '404')
  f.records.clear()
  f.fail()
  await until(() => f.task(b).status === 'error')
  assert.match(f.task(c).errorMessage, /退出/)
  await f.manager.resume(b)
  assert.equal(f.task(b).status, 'active')
})

test('启动失败保留错误，修复后可以重试；无效输入不添加任务', async (t) => {
  const f = fixture(t)
  f.launchError(new Error('未找到下载引擎'))
  const a = await f.add('a')
  assert.equal(f.task(a).status, 'error')
  f.launchError(null)
  await f.manager.resume(a)
  assert.equal(f.task(a).status, 'active')
  await assert.rejects(f.add('a'), /保存路径/)
  await assert.rejects(f.add('bad', { filename: '../bad.zip' }), /文件名/)
  await assert.rejects(f.add('bad', { url: 'file:///etc/passwd' }), /仅支持/)
  await assert.rejects(f.manager.remove(a), /先取消/)
  writeFileSync(join(f.dir, 'a.zip'), 'partial')
  await f.manager.cancel(a)
  await f.manager.remove(a)
  assert.equal(existsSync(join(f.dir, 'a.zip')), true)
  assert.equal(f.manager.list().tasks.length, 0)
})

test('引擎请求超时停止所有运行和排队任务，避免错误释放位置', async (t) => {
  const f = fixture(t)
  await f.add('a')
  await f.add('b')
  await f.add('c')
  f.driver.status = async () => {
    throw new Error('请求超时')
  }
  await until(() => f.manager.list().tasks.every((task) => task.status === 'error'))
  assert.equal(f.records.size, 0)
  assert.ok(f.manager.list().tasks.every((task) => task.errorMessage.includes('超时')))
})

test('新增请求超时后关闭引擎，不遗留无法追踪的下载', async (t) => {
  const f = fixture(t)
  await f.add('a')
  f.driver.add = async () => {
    const error = new Error('请求超时')
    error.engineUnavailable = true
    throw error
  }
  await f.add('b')
  assert.equal(f.records.size, 0)
  assert.ok(f.manager.list().tasks.every((task) => task.status === 'error'))
})

test('损坏记录保留备份，保存失败显示警告', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-history-'))
  const historyPath = join(dir, 'history.json')
  writeFileSync(historyPath, '{broken')
  const f = fixture(t, { historyPath })
  assert.match(f.manager.list().warning, /读取失败/)
  assert.ok(readdirSync(dir).some((name) => name.startsWith('history.json.corrupt-')))
  await f.add('a')
  assert.equal(JSON.parse(readFileSync(historyPath, 'utf8')).tasks.length, 1)
  const blocked = join(dir, 'not-a-directory')
  writeFileSync(blocked, 'file')
  const other = fixture(t, { historyPath: join(blocked, 'history.json') })
  await other.add('b')
  assert.match(other.manager.list().warning, /未能保存/)
})
