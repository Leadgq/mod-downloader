import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCompositeDriver } from '../src/main/driver.mjs'
import { createHlsDriver } from '../src/main/hls/index.mjs'
import { createTaskManager } from '../src/main/task-manager.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail('等待任务状态超时')
}

// 回归测试：组合驱动曾把 "hls:" 前缀剥掉再传给 HLS 驱动，
// 导致第一次轮询就报“下载任务不存在或已结束”并触发引擎崩溃处理。
test('组合驱动按链接路由：m3u8 走 HLS、普通文件走 aria2，gid 整串透传', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-route-'))
  const segments = Array.from({ length: 4 }, (_, i) => Buffer.alloc(1200, i + 1))
  const base = await new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://x')
      if (url.pathname === '/video.m3u8') {
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        response.end(
          [
            '#EXTM3U',
            ...segments.map((_, i) => ['#EXTINF:2,', `v${i}.ts`]).flat(),
            '#EXT-X-ENDLIST'
          ].join('\n')
        )
        return
      }
      const index = Number(url.pathname.match(/^\/v(\d+)\.ts$/)?.[1])
      if (Number.isInteger(index)) {
        response.writeHead(200)
        response.end(segments[index])
        return
      }
      response.writeHead(404)
      response.end()
    })
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)))
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })

  const aria2Records = new Map()
  const aria2 = {
    setFailureHandler() {},
    async ensure() {},
    async add(task) {
      const gid = 'a2-' + task.id
      aria2Records.set(gid, {
        status: 'complete',
        totalLength: '10',
        completedLength: '10',
        downloadSpeed: '1',
        connections: '1',
        files: [{ path: join(task.dir, task.filename) }]
      })
      return gid
    },
    async status(gid) {
      if (!aria2Records.has(gid)) throw new Error('引擎断开')
      return aria2Records.get(gid)
    },
    async pause(gid) {
      aria2Records.get(gid).status = 'paused'
      return aria2Records.get(gid)
    },
    async resume(gid) {
      aria2Records.get(gid).status = 'active'
    },
    async remove(gid) {
      aria2Records.delete(gid)
    },
    async destroy() {
      aria2Records.clear()
    }
  }
  const driver = createCompositeDriver({ aria2, hls: createHlsDriver() })
  const manager = createTaskManager({
    driver,
    historyPath: join(dir, 'history.json'),
    pollMs: 15,
    saveMs: 30
  })
  t.after(() => manager.destroy())

  await manager.add({ url: `${base}/video.m3u8`, dir, filename: 'audio.ts', connections: 2 })
  await manager.add({
    url: 'https://example.com/file.zip',
    dir,
    filename: 'file.zip',
    connections: 2
  })
  await until(() =>
    manager.list().tasks.every((task) => !['active', 'waiting'].includes(task.status))
  )

  const tasks = manager.list().tasks
  const hlsTask = tasks.find((task) => task.filename === 'audio.ts')
  const zipTask = tasks.find((task) => task.filename === 'file.zip')
  assert.equal(hlsTask.status, 'complete', hlsTask.errorMessage)
  assert.equal(hlsTask.percent, 100)
  assert.deepEqual(readFileSync(join(dir, 'audio.ts')), Buffer.concat(segments))
  assert.equal(zipTask.status, 'complete')
  assert.equal(aria2Records.size, 1)
})
