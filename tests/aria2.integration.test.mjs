import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAria2Driver } from '../src/main/aria2-driver.mjs'
import { createTaskManager } from '../src/main/task-manager.mjs'

const exe = fileURLToPath(new URL('../resources/bin/win32/aria2c.exe', import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(50)
  }
  assert.fail('真实下载未能在限定时间完成')
}

test(
  '真实 aria2：五任务排队、暂停补位、重启后 Range 续传及完成校验',
  { skip: process.platform !== 'win32' || !existsSync(exe), timeout: 60000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mod-aria2-'))
    const data = Buffer.alloc(4 * 1024 * 1024, 73)
    const ranges = []
    const server = createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
      const start = match ? Number(match[1]) : 0
      const end = match?.[2] ? Number(match[2]) : data.length - 1
      ranges.push({ path: req.url, start })
      res.writeHead(match ? 206 : 200, {
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {})
      })
      let offset = start
      const timer = setInterval(() => {
        if (offset > end) {
          clearInterval(timer)
          res.end()
          return
        }
        const next = Math.min(offset + 32768, end + 1)
        res.write(data.subarray(offset, next))
        offset = next
      }, 12)
      res.once('close', () => clearInterval(timer))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    // Occupying the old hard-coded port must not interfere with the new driver.
    const occupied = createTcpServer()
    await new Promise((resolve) => {
      occupied.once('error', resolve)
      occupied.listen(6800, '127.0.0.1', resolve)
    })
    t.after(() => occupied.close())
    const historyPath = join(dir, 'history.json')
    let manager = createTaskManager({ driver: createAria2Driver({ exe }), historyPath, pollMs: 50 })
    t.after(() => manager.destroy())
    const url = `http://127.0.0.1:${server.address().port}`
    for (let i = 0; i < 5; i++)
      await manager.add({ url: `${url}/${i}.bin`, dir, filename: `${i}.bin`, connections: 1 })
    const ids = manager.list().tasks.map((task) => task.id)
    assert.deepEqual(
      manager.list().tasks.map((task) => task.status),
      ['active', 'active', 'waiting', 'waiting', 'waiting']
    )
    await until(() => manager.list().tasks[0].completedLength > 262144)
    await manager.pause(ids[0])
    const paused = manager.list().tasks[0]
    assert.equal(paused.status, 'paused')
    assert.ok(paused.completedLength > 0)
    assert.equal(manager.list().tasks[2].status, 'active')
    await manager.cancel(ids[1])
    assert.equal(manager.list().tasks[3].status, 'active')
    await manager.destroy()
    manager = createTaskManager({ driver: createAria2Driver({ exe }), historyPath, pollMs: 50 })
    assert.equal(manager.list().tasks[0].status, 'paused')
    assert.equal(manager.list().tasks[1].status, 'cancelled')
    const rangeIndex = ranges.length
    await manager.resume(ids[0])
    await until(() => manager.list().tasks[0].status === 'complete')
    assert.ok(
      ranges.slice(rangeIndex).some((item) => item.path === '/0.bin' && item.start > 0),
      '重启后必须发送非零 Range'
    )
    assert.deepEqual(readFileSync(join(dir, '0.bin')), data)
    for (const id of ids.slice(2)) await manager.resume(id)
    await until(
      () => manager.list().tasks.filter((task) => task.status === 'complete').length === 4
    )
    for (const i of [2, 3, 4]) assert.deepEqual(readFileSync(join(dir, `${i}.bin`)), data)
  }
)

test('真实引擎缺失与无法执行均返回错误', async () => {
  const missing = createAria2Driver({ exe: join(tmpdir(), 'missing-aria2-binary.exe') })
  await assert.rejects(missing.ensure(), /未找到/)
  const invalid = createAria2Driver({ exe: fileURLToPath(import.meta.url) })
  await assert.rejects(invalid.ensure(), /启动失败|无法启动|ENOEXEC|EINVAL/)
})

test(
  '真实 aria2 异常退出后任务失败，重试重新启动引擎',
  { skip: process.platform !== 'win32' || !existsSync(exe) },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mod-engine-failure-'))
    let engine
    const driver = createAria2Driver({
      exe,
      spawnProcess: (...args) => {
        engine = spawn(...args)
        return engine
      }
    })
    const manager = createTaskManager({
      driver,
      historyPath: join(dir, 'history.json'),
      pollMs: 10000
    })
    t.after(() => manager.destroy())
    await manager.add({ url: 'http://127.0.0.1:1/blocked.zip', dir, filename: 'blocked.zip' })
    const id = manager.list().tasks[0].id
    engine.kill()
    await until(() => manager.list().tasks[0].status === 'error')
    assert.match(manager.list().tasks[0].errorMessage, /退出/)
    const oldEngine = engine
    await manager.resume(id)
    assert.notEqual(engine, oldEngine)
    assert.equal(manager.list().tasks[0].status, 'active')
  }
)
