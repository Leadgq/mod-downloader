import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHlsDriver } from '../src/main/hls.mjs'

async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('等待 HLS 生命周期状态超时')
}
function muxFixture(t, initialMode = 'stall', timeoutMs = 10000) {
  const dir = mkdtempSync(join(tmpdir(), 'hls-lifecycle-'))
  const state = { calls: 0, killed: 0, requests: [], mode: initialMode }
  const driver = createHlsDriver({
    ffmpegPath: process.execPath,
    ffmpegTimeoutMs: timeoutMs,
    maxRetries: 0,
    maxSegmentAttempts: 1,
    spawnImpl: (_exe, args) => {
      state.calls++
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {
        state.killed++
        queueMicrotask(() => child.emit('close', 1))
      }
      queueMicrotask(() => {
        if (state.mode === 'fail') {
          child.stderr.emit('data', Buffer.from('invalid mux input'))
          child.emit('close', 1)
        } else if (state.mode === 'finish') {
          writeFileSync(args.at(-1), 'MUXED')
          child.emit('close', 0)
        }
      })
      return child
    },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname
      state.requests.push(path)
      if (path === '/master.m3u8')
        return new Response(
          [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="default",DEFAULT=YES,URI="audio.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
            'video.m3u8'
          ].join('\n')
        )
      if (path.endsWith('.m3u8'))
        return new Response(
          [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:2',
            '#EXTINF:2,',
            path === '/audio.m3u8' ? 'audio.ts' : 'video.ts',
            '#EXT-X-ENDLIST'
          ].join('\n')
        )
      return new Response('DATA')
    }
  })
  t.after(() => driver.destroy())
  return {
    driver,
    dir,
    state,
    add: () =>
      driver.add({
        uri: 'https://example.test/master.m3u8',
        filename: 'video.mp4',
        dir,
        connectionsLimit: 2
      })
  }
}

test('合成期间暂停：停止 FFmpeg、保留分片，继续时复用分片并重新合成', async (t) => {
  const f = muxFixture(t)
  const gid = await f.add()
  await until(() => f.state.calls === 1)
  const status = await f.driver.pause(gid)
  assert.equal(status.status, 'paused')
  assert.equal(f.state.killed, 1)
  assert.equal(existsSync(join(f.dir, 'video.mp4')), false)
  assert.equal(existsSync(join(f.dir, '.video.mp4.hls-parts', 'metadata.json')), true)
  const count = f.state.requests.filter((path) => path.endsWith('.ts')).length
  f.state.mode = 'finish'
  await f.driver.resume(gid)
  await until(() => f.driver.status(gid).status !== 'active')
  assert.equal(f.driver.status(gid).status, 'complete')
  assert.equal(f.state.calls, 2)
  assert.equal(f.state.requests.filter((path) => path.endsWith('.ts')).length, count)
  assert.equal(readFileSync(join(f.dir, 'video.mp4'), 'utf8'), 'MUXED')
})

test('合成期间取消：等待 FFmpeg 退出，不产生最终文件', async (t) => {
  const f = muxFixture(t)
  const gid = await f.add()
  await until(() => f.state.calls === 1)
  await f.driver.remove(gid)
  assert.equal(f.state.killed, 1)
  assert.equal(existsSync(join(f.dir, 'video.mp4')), false)
  assert.throws(() => f.driver.status(gid), /不存在/)
})

test('合成失败保留有效分片，重新添加同一任务不重下', async (t) => {
  const f = muxFixture(t, 'fail')
  const first = await f.add()
  await until(() => f.driver.status(first).status !== 'active')
  assert.equal(f.driver.status(first).status, 'error')
  assert.match(f.driver.status(first).errorMessage, /FFmpeg 合成失败/)
  const count = f.state.requests.filter((path) => path.endsWith('.ts')).length
  f.state.mode = 'finish'
  const next = await f.add()
  await until(() => f.driver.status(next).status !== 'active')
  assert.equal(f.driver.status(next).status, 'complete')
  assert.equal(f.state.requests.filter((path) => path.endsWith('.ts')).length, count)
})

test('FFmpeg 超时停止子进程并报告错误', async (t) => {
  const f = muxFixture(t, 'stall', 10)
  const gid = await f.add()
  await until(() => f.driver.status(gid).status !== 'active')
  assert.equal(f.state.killed, 1)
  assert.equal(f.driver.status(gid).status, 'error')
  assert.match(f.driver.status(gid).errorMessage, /超时/)
})

test('下载后目标文件被其他程序创建时，发布不得覆盖现有文件', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hls-publish-'))
  const target = join(dir, 'video.ts')
  const driver = createHlsDriver({
    maxRetries: 0,
    maxSegmentAttempts: 1,
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST')
      writeFileSync(target, 'EXISTING')
      return new Response('DOWNLOADED')
    }
  })
  t.after(() => driver.destroy())
  const gid = await driver.add({
    uri: 'https://example.test/index.m3u8',
    dir,
    filename: 'video.ts'
  })
  await until(() => driver.status(gid).status !== 'active')
  assert.equal(driver.status(gid).status, 'error')
  assert.equal(readFileSync(target, 'utf8'), 'EXISTING')
  assert.equal(existsSync(join(dir, '.video.ts.hls-parts', '000000.part')), true)
})
