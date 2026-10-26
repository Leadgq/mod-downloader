import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHlsDriver, isHlsUri, parseM3u8, resolveSource } from '../src/main/hls.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail('等待任务状态超时')
}

function startServer(t, handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)))
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

function track(driver, gid) {
  const state = { done: false, error: '', last: null }
  void (async () => {
    await until(async () => {
      const status = await driver.status(gid)
      state.last = status
      if (status.status === 'error') {
        // 状态先于错误信息置位，等一拍让 errorMessage 填上
        if (!status.errorMessage) return false
        state.error = status.errorMessage
        return true
      }
      return status.status === 'complete'
    })
    state.done = true
  })()
  return state
}

test('isHlsUri 识别 m3u8 链接', () => {
  assert.equal(isHlsUri('https://a.com/d/xx.m3u8?sign=abc'), true)
  assert.equal(isHlsUri('https://a.com/d/xx.M3U8'), true)
  assert.equal(isHlsUri('https://a.com/file.zip'), false)
  assert.equal(isHlsUri('不是链接'), false)
})

test('parseM3u8 解析媒体播放列表（密钥、初始化段、字节范围、序号）', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.php?k=1",IV=0x9c7db8778570d05c3177c349fd9236aa',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.006,',
    'seg0.ts',
    '#EXT-X-BYTERANGE:1000@500',
    '#EXTINF:6.006,',
    'seg0.ts',
    '#EXT-X-BYTERANGE:2000',
    '#EXTINF:4,',
    'seg1.ts',
    '#EXT-X-ENDLIST'
  ].join('\n')
  const playlist = parseM3u8(text)
  assert.equal(playlist.isMaster, false)
  assert.equal(playlist.live, false)
  assert.equal(playlist.mediaSequence, 7)
  assert.equal(playlist.segments.length, 3)
  assert.equal(playlist.segments[0].key.METHOD, 'AES-128')
  assert.equal(playlist.segments[0].key.URI, 'key.php?k=1')
  assert.equal(playlist.segments[0].map.uri, 'init.mp4')
  assert.deepEqual(playlist.segments[1].byteRange, { offset: 500, length: 1000 })
  // 未写 offset 的 BYTERANGE 接在上一段范围之后
  assert.deepEqual(playlist.segments[2].byteRange, { offset: 1500, length: 2000 })
})

test('parseM3u8 解析主播放列表并识别直播流', () => {
  const master = parseM3u8(
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000',
      'high/index.m3u8'
    ].join('\n')
  )
  assert.equal(master.isMaster, true)
  assert.equal(master.variants.length, 2)
  assert.equal(master.variants[1].uri, 'high/index.m3u8')
  assert.equal(master.variants[1].bandwidth, 2400000)

  const live = parseM3u8(['#EXTM3U', '#EXTINF:4,', 'live0.ts'].join('\n'))
  assert.equal(live.live, true)
})

test('resolveSource 继承同源查询串，不覆盖已有参数，跨源不继承', () => {
  const base = 'https://cdn.example.com/d/a/index.m3u8?sign=abc%3D123'
  assert.equal(resolveSource('seg0.ts', base), 'https://cdn.example.com/d/a/seg0.ts?sign=abc%3D123')
  assert.equal(
    resolveSource('seg0.ts?token=1', base),
    'https://cdn.example.com/d/a/seg0.ts?token=1'
  )
  assert.equal(resolveSource('seg0.ts', base), 'https://cdn.example.com/d/a/seg0.ts?sign=abc%3D123')
  assert.equal(resolveSource('https://other.com/seg0.ts', base), 'https://other.com/seg0.ts')
})

test('端到端：签名分片 + AES-128 解密 + 主播放列表选最高码率', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const key = Buffer.from('0123456789abcdef')
  const mediaSequence = 7
  const plainSegments = [0, 1, 2, 3].map((index) =>
    Buffer.concat([Buffer.from([index]), Buffer.alloc(5000, index + 1)])
  )
  const encrypt = (buffer, sequence) => {
    const iv = Buffer.from(sequence.toString(16).padStart(32, '0'), 'hex')
    const cipher = createCipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([cipher.update(buffer), cipher.final()])
  }
  const encrypted = plainSegments.map((buffer, index) => encrypt(buffer, mediaSequence + index))
  const requested = { variants: new Set(), segments: new Set() }
  const lowSegments = [Buffer.from('low-quality')]

  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    const send = (body, type = 'application/octet-stream', status = 200) => {
      response.writeHead(status, { 'Content-Type': type })
      response.end(body)
    }
    if (!url.searchParams.has('sign')) {
      send('<!DOCTYPE html><html><body>shield</body></html>', 'text/html', 403)
      return
    }
    if (url.pathname === '/master.m3u8') {
      send(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhigh/index.m3u8\n',
        'application/vnd.apple.mpegurl'
      )
      return
    }
    if (url.pathname === '/high/index.m3u8') {
      requested.variants.add(url.pathname)
      send(
        [
          '#EXTM3U',
          `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          ...encrypted.flatMap((_, index) => ['#EXTINF:5,', `enc${index}.ts`]),
          '#EXT-X-ENDLIST'
        ].join('\n'),
        'application/vnd.apple.mpegurl'
      )
      return
    }
    if (url.pathname === '/low/index.m3u8') {
      requested.variants.add(url.pathname)
      send(
        ['#EXTM3U', '#EXTINF:5,', 'low0.ts', '#EXT-X-ENDLIST'].join('\n'),
        'application/vnd.apple.mpegurl'
      )
      return
    }
    if (url.pathname === '/high/key.bin') {
      send(key)
      return
    }
    if (url.pathname.startsWith('/high/enc')) {
      requested.segments.add(url.pathname)
      send(encrypted[Number(url.pathname.match(/enc(\d)/)[1])])
      return
    }
    if (url.pathname === '/high/master.m3u8' || url.pathname === '/low/low0.ts') {
      requested.segments.add(url.pathname)
      send(lowSegments[0])
      return
    }
    send('not found', 'text/plain', 404)
  })

  const driver = createHlsDriver()
  t.after(() => driver.destroy())
  const gid = await driver.add(
    { uri: `${base}/master.m3u8?sign=test`, dir, filename: '', connectionsLimit: 4 },
    ''
  )
  const status = track(driver, gid)
  await until(() => status.done)
  assert.equal(status.error, '')

  assert.deepEqual(requested.variants, new Set(['/high/index.m3u8']))
  assert.equal(requested.segments.size, 4)

  const finalStatus = await driver.status(gid)
  assert.equal(finalStatus.status, 'complete')
  assert.equal(finalStatus.totalLength, finalStatus.completedLength)
  const expected = Buffer.concat(plainSegments)
  assert.deepEqual(readFileSync(join(dir, 'master.ts')), expected)
  // 合并后临时分片目录应被清理
  assert.equal(existsSync(join(dir, '.master.ts.hls-parts')), false)
  assert.equal(existsSync(join(dir, 'master.ts.merging')), false)
})

test('端到端：暂停后继续，已下载分片不重复请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const total = 16
  const serves = new Map()
  const segments = Array.from({ length: total }, (_, index) =>
    Buffer.concat([Buffer.from([index]), Buffer.alloc(2000, index + 1)])
  )
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/index.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          ...segments.map((_, index) => ['#EXTINF:2,', `s${index}.ts`]).flat(),
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      return
    }
    const index = Number(url.pathname.match(/^\/s(\d+)\.ts$/)?.[1])
    if (Number.isInteger(index)) {
      setTimeout(() => {
        serves.set(index, (serves.get(index) || 0) + 1)
        response.writeHead(200)
        response.end(segments[index])
      }, 30)
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver()
  t.after(() => driver.destroy())
  const gid = await driver.add(
    { uri: `${base}/index.m3u8`, dir, filename: 'video.ts', connectionsLimit: 2 },
    ''
  )
  await until(async () => (await driver.status(gid)).completedLength > 0)
  const status = await driver.pause(gid)
  assert.equal(status.status, 'paused')
  // 等被中止请求在服务端的残留定时器结束，再取快照
  await sleep(150)
  const pausedServes = new Map(serves)
  const pausedParts = readdirSync(join(dir, '.video.ts.hls-parts'))
    .map((name) => Number(name.split('.')[0]))
    .filter((index) => Number.isInteger(index))
  assert.ok(pausedParts.length > 0, '暂停前应有分片完成')

  await driver.resume(gid)
  await until(async () => (await driver.status(gid)).status === 'complete', 20000)

  // 暂停时已完整落盘的分片不应被重新请求
  for (const index of pausedParts) assert.equal(serves.get(index), pausedServes.get(index))
  assert.deepEqual(readFileSync(join(dir, 'video.ts')), Buffer.concat(segments))
})

test('直播流、验证网页、目标文件已存在给出明确错误', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/live.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXTINF:4,\nlive0.ts\n')
      return
    }
    if (url.pathname === '/shielded.m3u8') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!DOCTYPE html><html><title>正在验证</title></html>')
      return
    }
    if (url.pathname === '/vod.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXTINF:4,\nv0.ts\n#EXT-X-ENDLIST')
      return
    }
    if (url.pathname === '/v0.ts') {
      response.writeHead(200)
      response.end(Buffer.alloc(10))
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver()
  t.after(() => driver.destroy())
  const add = (uri, filename = '') => driver.add({ uri, dir, filename, connectionsLimit: 2 }, '')
  const waitError = async (gid) => {
    let status
    await until(async () => {
      status = await driver.status(gid)
      return status.status === 'error'
    })
    return status.errorMessage
  }

  assert.match(await waitError(await add(`${base}/live.m3u8`)), /直播/)
  assert.match(await waitError(await add(`${base}/shielded.m3u8`)), /Cookie/)

  writeFileSync(join(dir, 'exists.ts'), 'x')
  assert.match(await waitError(await add(`${base}/vod.m3u8`, 'exists.ts')), /已存在/)
})

test('删除任务与销毁不再产生新请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  let hits = 0
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/index.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          ...Array.from({ length: 30 }, (_, i) => ['#EXTINF:2,', `s${i}.ts`]).flat(),
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      return
    }
    hits++
    setTimeout(() => {
      response.writeHead(200)
      response.end(Buffer.alloc(100))
    }, 20)
  })
  const driver = createHlsDriver()
  const gid = await driver.add(
    { uri: `${base}/index.m3u8`, dir, filename: 'x.ts', connectionsLimit: 2 },
    ''
  )
  await until(async () => hits > 0)
  await driver.remove(gid)
  await driver.destroy()
  const count = hits
  await sleep(200)
  assert.equal(hits, count)
  // 取消后已下载的分片保留，便于日后重新添加同一链接续传
  assert.equal(existsSync(join(dir, '.x.ts.hls-parts')), true)
})

test('与任务管理器集成：m3u8 任务走完整的添加、轮询、暂停、继续、完成流程', async (t) => {
  const { createTaskManager } = await import('../src/main/task-manager.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const total = 10
  const segments = Array.from({ length: total }, (_, i) => Buffer.alloc(1500, i + 1))
  const base = await startServer(t, (request, response) => {
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
      setTimeout(() => {
        response.writeHead(200)
        response.end(segments[index])
      }, 15)
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver()
  const manager = createTaskManager({
    driver,
    historyPath: join(dir, 'history.json'),
    pollMs: 15,
    saveMs: 30
  })
  t.after(() => manager.destroy())

  await manager.add({ url: `${base}/video.m3u8`, dir, filename: '', connections: 3 })
  let task = manager.list().tasks[0]
  assert.equal(task.status, 'active')
  await until(async () => {
    task = manager.list().tasks[0]
    return (
      ['active', 'paused', 'complete', 'error'].includes(task.status) && task.completedLength > 0
    )
  })
  const id = task.id
  await manager.pause(id)
  task = manager.list().tasks.find((item) => item.id === id)
  assert.equal(task.status, 'paused')

  await manager.resume(id)
  await until(() => manager.list().tasks.find((item) => item.id === id).status === 'complete')
  task = manager.list().tasks.find((item) => item.id === id)
  assert.equal(task.percent, 100)
  assert.equal(task.filename, 'video.ts')
  assert.deepEqual(readFileSync(join(dir, 'video.ts')), Buffer.concat(segments))
})

test('remux：下载完成后用内置 ffmpeg 无损转封装为 m4a', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const ffmpegPath = fileURLToPath(new URL('../resources/bin/win32/ffmpeg.exe', import.meta.url))
  if (!existsSync(ffmpegPath)) return t.skip('本机未放置 ffmpeg.exe，跳过转封装测试')

  // 用 ffmpeg 生成 1 秒真实 AAC 音频的 TS 分片
  const workdir = mkdtempSync(join(tmpdir(), 'mod-remux-'))
  const tsFile = join(workdir, 'sample.ts')
  const made = spawnSync(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'aac',
    tsFile
  ])
  assert.equal(made.status, 0, `生成测试 TS 失败：${made.stderr?.toString().slice(-400)}`)
  const media = readFileSync(tsFile)

  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/audio.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXTINF:1,\na0.ts\n#EXT-X-ENDLIST')
      return
    }
    if (url.pathname === '/a0.ts') {
      response.writeHead(200)
      response.end(media)
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver({ ffmpegPath })
  t.after(() => driver.destroy())
  const gid = await driver.add(
    { uri: `${base}/audio.m3u8`, dir, filename: '', connectionsLimit: 1 },
    ''
  )
  let status
  await until(async () => {
    status = await driver.status(gid)
    return status.status !== 'active'
  }, 20000)
  assert.equal(status.status, 'complete', status.errorMessage)

  const finalFile = status.files[0].path
  assert.ok(finalFile.endsWith('.m4a'), `应转成 m4a，实际：${finalFile}`)
  assert.ok(existsSync(finalFile))
  assert.equal(existsSync(join(dir, 'audio.ts')), false, '.ts 应被清理')
  // MP4 系容器第 4-8 字节是 ftyp
  assert.equal(readFileSync(finalFile).subarray(4, 8).toString(), 'ftyp')
})

test('自适应调速：分片先失败后恢复时，任务仍能完成', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const total = 6
  const segments = Array.from({ length: total }, (_, i) => Buffer.alloc(1500 + i, i + 1))
  const hits = new Map()
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/index.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          ...segments.map((_, i) => ['#EXTINF:2,', `s${i}.ts`]).flat(),
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      return
    }
    const index = Number(url.pathname.match(/^\/s(\d+)\.ts$/)?.[1])
    if (Number.isInteger(index)) {
      const count = (hits.get(index) || 0) + 1
      hits.set(index, count)
      if (count <= 2) {
        // 模拟弱网截断：声明完整长度却只发一半就断开
        response.writeHead(200, { 'Content-Length': String(segments[index].length) })
        response.write(segments[index].subarray(0, 700))
        setTimeout(() => response.destroy(), 5)
        return
      }
      response.writeHead(200, { 'Content-Length': String(segments[index].length) })
      response.end(segments[index])
      return
    }
    response.writeHead(404)
    response.end()
  })

  // maxRetries 0：跳过请求内快速重试，直接锻炼分片回队+调速机制
  const driver = createHlsDriver({ maxRetries: 0, errorBackoffBaseMs: 50 })
  t.after(() => driver.destroy())
  const gid = await driver.add(
    { uri: `${base}/index.m3u8`, dir, filename: 'flaky.ts', connectionsLimit: 4 },
    ''
  )
  let status
  await until(async () => {
    status = await driver.status(gid)
    return status.status !== 'active'
  }, 20000)
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.deepEqual(readFileSync(join(dir, 'flaky.ts')), Buffer.concat(segments))
  // 每个分片都被打过至少 3 次（2 次截断 + 1 次成功）
  assert.ok([...hits.values()].every((count) => count >= 3))
})

test('自适应调速：降到 1 后，实际下载并发逐级恢复到设定上限', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const limit = 8
  const segments = Array.from({ length: 96 }, (_, i) => Buffer.alloc(100 + i, i))
  const hits = new Map()
  const successful = new Map()
  const samples = []
  let activeRequests = 0
  let completed = 0
  const driver = createHlsDriver({
    maxRetries: 0,
    errorBackoffBaseMs: 5,
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8')) {
        return new Response(
          [
            '#EXTM3U',
            ...segments.flatMap((_, i) => ['#EXTINF:2,', `s${i}.ts`]),
            '#EXT-X-ENDLIST'
          ].join('\n')
        )
      }
      const index = Number(new URL(url).pathname.match(/s(\d+)\.ts$/)[1])
      const count = (hits.get(index) || 0) + 1
      hits.set(index, count)
      // 首批请求同时失败，把并发从 8 压到 1；之后线路保持正常。
      if (index < limit && count === 1) throw new Error('高峰期连接中断')
      activeRequests++
      samples.push({ completed, activeRequests })
      try {
        await sleep(10)
        completed++
        successful.set(index, (successful.get(index) || 0) + 1)
        return new Response(segments[index])
      } finally {
        activeRequests--
      }
    }
  })
  t.after(() => driver.destroy())
  const gid = await driver.add({
    uri: 'https://example.test/index.m3u8',
    dir,
    filename: 'recover.ts',
    connectionsLimit: limit
  })
  await until(() => driver.status(gid).status !== 'active')
  const status = driver.status(gid)
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.equal(samples.find((sample) => sample.completed === 0).activeRequests, 1)
  assert.equal(
    Math.max(...samples.map((sample) => sample.activeRequests)),
    limit,
    '线路恢复后必须补充实际下载 worker，不能只修改允许并发数'
  )
  assert.equal(successful.size, segments.length)
  assert.ok(
    [...successful.values()].every((count) => count === 1),
    '每个分片只能成功下载一次'
  )
  assert.deepEqual(readFileSync(join(dir, 'recover.ts')), Buffer.concat(segments))
})

test('自适应调速：单分片始终失败达到上限后任务报错，其余分片保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const total = 4
  const segments = Array.from({ length: total }, (_, i) => Buffer.alloc(1200, i + 1))
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (url.pathname === '/index.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          ...segments.map((_, i) => ['#EXTINF:2,', `s${i}.ts`]).flat(),
          '#EXT-X-ENDLIST'
        ].join('\n')
      )
      return
    }
    const index = Number(url.pathname.match(/^\/s(\d+)\.ts$/)?.[1])
    if (Number.isInteger(index)) {
      if (index === 2) {
        response.writeHead(200, { 'Content-Length': String(segments[index].length) })
        response.write(segments[index].subarray(0, 100))
        setTimeout(() => response.destroy(), 5)
        return
      }
      response.writeHead(200)
      response.end(segments[index])
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver({ maxRetries: 0, maxSegmentAttempts: 3, errorBackoffBaseMs: 50 })
  t.after(() => driver.destroy())
  const gid = await driver.add(
    { uri: `${base}/index.m3u8`, dir, filename: 'broken.ts', connectionsLimit: 3 },
    ''
  )
  let status
  await until(async () => {
    status = await driver.status(gid)
    return status.status === 'error'
  }, 20000)
  assert.match(status.errorMessage, /分片 3 连续下载失败/)
  // 好的分片应已落盘，等修好线路后重试可续传
  const parts = readdirSync(join(dir, '.broken.ts.hls-parts')).filter((name) =>
    name.endsWith('.part')
  )
  assert.equal(parts.length, 3)
})

test('超长文件名自动截断，Windows 可正常落盘', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mod-hls-'))
  const longName = '极长'.repeat(120) + '.m3u8'
  const media = Buffer.alloc(800, 9)
  const base = await startServer(t, (request, response) => {
    const url = new URL(request.url, 'http://x')
    if (decodeURIComponent(url.pathname) === `/${longName}`) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      response.end('#EXTM3U\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST')
      return
    }
    if (url.pathname === '/seg0.ts') {
      response.writeHead(200)
      response.end(media)
      return
    }
    response.writeHead(404)
    response.end()
  })

  const driver = createHlsDriver()
  t.after(() => driver.destroy())
  const gid = await driver.add(
    {
      uri: `${base}/${encodeURIComponent(longName)}?sign=x`,
      dir,
      filename: '',
      connectionsLimit: 1
    },
    ''
  )
  let status
  await until(async () => {
    status = await driver.status(gid)
    return status.status !== 'active'
  }, 15000)
  assert.equal(status.status, 'complete', status.errorMessage)
  const finalFile = status.files[0].path
  const name = finalFile.split(/[\\/]/).pop()
  assert.ok(name.length <= 75, `文件名应被截断，实际 ${name.length} 字符: ${name}`)
  assert.match(name, /~[0-9a-f]{6}\.ts$/)
  assert.ok(existsSync(finalFile))
})
