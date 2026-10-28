import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHlsDriver, parseM3u8 } from '../../src/main/hls/index.mjs'
import HLS from 'hls-parser'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const playlist = (...lines) =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:2', ...lines, '#EXT-X-ENDLIST'].join('\n')
const segment = (uri) => ['#EXTINF:2,', uri]
const encrypt = (body, key, iv) => {
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(body), cipher.final()])
}
async function until(check) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return
    await sleep(5)
  }
  assert.fail('等待下载超时')
}
function fixture(t, serve, dir = mkdtempSync(join(tmpdir(), 'hls-regression-'))) {
  const hits = []
  const driver = createHlsDriver({
    maxRetries: 0,
    maxSegmentAttempts: 1,
    fetchImpl: async (uri, options) => {
      hits.push(new URL(uri).pathname)
      const result = await serve(new URL(uri), options)
      return result instanceof Response ? result : new Response(result)
    }
  })
  t.after(() => driver.destroy())
  return {
    driver,
    hits,
    dir,
    async add(filename = 'video.ts', uri = 'https://example.test/index.m3u8') {
      const gid = await driver.add({ uri, filename, dir, connectionsLimit: 2 }, 'secret-cookie')
      return gid
    },
    async finish(gid) {
      await until(() => driver.status(gid).status !== 'active')
      return driver.status(gid)
    }
  }
}

test('适配层：Map 使用声明时的 Key，后续切换 Key / METHOD=NONE 不改变旧 Map', () => {
  const result = parseM3u8(
    playlist(
      '#EXT-X-KEY:METHOD=AES-128,URI="a.key",IV=0x00000000000000000000000000000001',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="b.key",IV=0x00000000000000000000000000000002',
      ...segment('a.m4s'),
      '#EXT-X-KEY:METHOD=NONE',
      ...segment('b.m4s')
    )
  )
  assert.equal(result.segments[0].key.URI, 'b.key')
  assert.equal(result.segments[0].map.key.URI, 'a.key')
  assert.equal(result.segments[1].key, null)
  assert.equal(result.segments[1].map.key.URI, 'a.key')
})

test('适配层：拒绝跨资源和首片的隐式字节偏移', () => {
  assert.throws(
    () =>
      parseM3u8(
        playlist(
          '#EXT-X-BYTERANGE:3@0',
          ...segment('a.ts'),
          '#EXT-X-BYTERANGE:3',
          ...segment('b.ts')
        )
      ),
    /字节范围/
  )
  assert.throws(() => parseM3u8(playlist('#EXT-X-BYTERANGE:3', ...segment('a.ts'))), /字节范围/)
})

test('适配层：短 IV 左补零，解析后恢复库调用者的严格模式及日志选项', () => {
  const previous = HLS.getOptions()
  HLS.setOptions({ strictMode: true, silent: false })
  try {
    const parsed = parseM3u8(
      playlist('#EXT-X-KEY:METHOD=AES-128,URI="a.key",IV=0x1', ...segment('a.ts'))
    )
    assert.equal(parsed.segments[0].key.IV, '0x00000000000000000000000000000001')
    assert.equal(HLS.getOptions().strictMode, true)
    assert.equal(HLS.getOptions().silent, false)
  } finally {
    HLS.setOptions({ ...previous, strictMode: previous.strictMode, silent: previous.silent })
  }
})

test('适配层：保留独立音轨、仅关键帧标识及 discontinuity', () => {
  const master = parseM3u8(
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=9000000,URI="iframe.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"',
      'video.m3u8'
    ].join('\n')
  )
  assert.equal(master.variants.find((item) => item.isIFrameOnly).uri, 'iframe.m3u8')
  assert.equal(master.variants.find((item) => !item.isIFrameOnly).audio[0].isDefault, true)
  assert.equal(
    parseM3u8(playlist(...segment('a.ts'), '#EXT-X-DISCONTINUITY', ...segment('b.ts'))).segments[1]
      .discontinuity,
    true
  )
})

test('fMP4：初始化段与媒体分片分别使用自己的 Key / IV，最终包含初始化段', async (t) => {
  const keyA = Buffer.alloc(16, 1)
  const keyB = Buffer.alloc(16, 2)
  const ivA = Buffer.alloc(16)
  ivA[15] = 1
  const ivB = Buffer.alloc(16)
  ivB[15] = 2
  const init = Buffer.from('INITIALIZATION')
  const media = Buffer.from('MEDIA')
  const f = fixture(
    t,
    (url) =>
      ({
        '/index.m3u8': playlist(
          '#EXT-X-KEY:METHOD=AES-128,URI="a.key",IV=0x00000000000000000000000000000001',
          '#EXT-X-MAP:URI="init.mp4"',
          '#EXT-X-KEY:METHOD=AES-128,URI="b.key",IV=0x00000000000000000000000000000002',
          ...segment('a.m4s')
        ),
        '/a.key': keyA,
        '/b.key': keyB,
        '/init.mp4': encrypt(init, keyA, ivA),
        '/a.m4s': encrypt(media, keyB, ivB)
      })[url.pathname]
  )
  const status = await f.finish(await f.add('video.mp4'))
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.deepEqual(readFileSync(status.files[0].path), Buffer.concat([init, media]))
  assert.equal(f.hits.filter((path) => path === '/a.key').length, 1)
  assert.equal(f.hits.filter((path) => path === '/b.key').length, 1)
})

test('逐片 Range：同一资源的显式和隐式范围按顺序合并', async (t) => {
  const f = fixture(t, (url, options) => {
    if (url.pathname.endsWith('.m3u8'))
      return playlist(
        '#EXT-X-BYTERANGE:3@0',
        ...segment('a.ts'),
        '#EXT-X-BYTERANGE:3',
        ...segment('a.ts')
      )
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range)
    const [start, end] = match.slice(1).map(Number)
    return new Response(Buffer.from('abcdef').subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/6`, 'Content-Length': '3' }
    })
  })
  const status = await f.finish(await f.add())
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.equal(readFileSync(status.files[0].path, 'utf8'), 'abcdef')
})

test('错误响应不能成为已完成分片：忽略 Range、错范围、空内容、错长度', async (t) => {
  for (const [name, ranged, response] of [
    ['忽略 Range', true, () => new Response('abcdef')],
    [
      '错范围',
      true,
      () => new Response('abc', { status: 206, headers: { 'Content-Range': 'bytes 3-5/6' } })
    ],
    ['空内容', false, () => new Response('')],
    ['错长度', false, () => new Response('abc', { headers: { 'Content-Length': '100' } })]
  ])
    await t.test(name, async (t) => {
      const f = fixture(t, (url) =>
        url.pathname.endsWith('.m3u8')
          ? playlist(...(ranged ? ['#EXT-X-BYTERANGE:3@0'] : []), ...segment('a.ts'))
          : response()
      )
      const status = await f.finish(await f.add())
      assert.equal(status.status, 'error')
      assert.equal(existsSync(join(f.dir, 'video.ts')), false)
      assert.equal(existsSync(join(f.dir, '.video.ts.hls-parts', '000000.part')), false)
    })
})

test('错误密钥必须失败，不允许关闭 PKCS7 后把乱码当成成功', async (t) => {
  const encrypted = encrypt(
    Buffer.from('this-is-a-real-segment'),
    Buffer.alloc(16, 1),
    Buffer.alloc(16)
  )
  const f = fixture(t, (url) =>
    url.pathname.endsWith('.m3u8')
      ? playlist('#EXT-X-KEY:METHOD=AES-128,URI="a.key"', ...segment('a.ts'))
      : url.pathname.endsWith('.key')
        ? Buffer.alloc(16, 2)
        : encrypted
  )
  const status = await f.finish(await f.add())
  assert.equal(status.status, 'error')
  assert.match(status.errorMessage, /解密失败/)
})

test('200 HTML 验证页面不能作为分片保存', async (t) => {
  const f = fixture(t, (url) =>
    url.pathname.endsWith('.m3u8')
      ? playlist(...segment('a.ts'))
      : '<!DOCTYPE html><html>verify</html>'
  )
  const status = await f.finish(await f.add())
  assert.equal(status.status, 'error')
  assert.match(status.errorMessage, /验证页面/)
})

test('失败分片的退避时间不会被其他 worker 提前领取绕过', async (t) => {
  const attempts = []
  const dir = mkdtempSync(join(tmpdir(), 'hls-retry-'))
  const driver = createHlsDriver({
    maxRetries: 0,
    maxSegmentAttempts: 2,
    errorBackoffBaseMs: 40,
    fetchImpl: async (url) => {
      if (url.endsWith('.m3u8'))
        return new Response(playlist(...['a.ts', 'b.ts', 'c.ts'].flatMap(segment)))
      if (url.endsWith('/a.ts')) {
        attempts.push(Date.now())
        if (attempts.length === 1) throw new Error('服务器暂时不可用')
      }
      await sleep(5)
      return new Response('DATA')
    }
  })
  t.after(() => driver.destroy())
  const gid = await driver.add({
    uri: 'https://example.test/index.m3u8',
    dir,
    filename: 'retry.ts',
    connectionsLimit: 4
  })
  await until(() => driver.status(gid).status !== 'active')
  assert.equal(driver.status(gid).status, 'complete')
  assert.equal(attempts.length, 2)
  assert.ok(attempts[1] - attempts[0] >= 35, `重试间隔只有 ${attempts[1] - attempts[0]}ms`)
})

test('加密 Map 无显式 IV、非 identity Key、缺失分片均明确拒绝', async (t) => {
  for (const [tags, message] of [
    [['#EXT-X-KEY:METHOD=AES-128,URI="a.key"', '#EXT-X-MAP:URI="init.mp4"'], /显式 IV/],
    [['#EXT-X-KEY:METHOD=AES-128,URI="a.key",KEYFORMAT="unsupported"'], /加密方式/],
    [['#EXT-X-GAP'], /缺失分片/]
  ]) {
    const f = fixture(t, () => playlist(...tags, ...segment('a.ts')))
    const status = await f.finish(await f.add())
    assert.equal(status.status, 'error')
    assert.match(status.errorMessage, message)
  }
})

test('无元数据的旧分片不复用，防止同名任务串片', async (t) => {
  const f = fixture(t, (url) =>
    url.pathname.endsWith('.m3u8') ? playlist(...segment('new.ts')) : 'NEW'
  )
  const parts = join(f.dir, '.video.ts.hls-parts')
  mkdirSync(parts)
  writeFileSync(join(parts, '000000.part'), 'OLD')
  const status = await f.finish(await f.add())
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.equal(readFileSync(status.files[0].path, 'utf8'), 'NEW')
  assert.ok(f.hits.includes('/new.ts'))
})

test('重启续传：签名刷新仍复用有效分片，同长度损坏分片必须重新下载', async (t) => {
  const bodies = Array.from({ length: 20 }, (_, i) => Buffer.alloc(100, i + 1))
  const serve = async (url) => {
    if (url.pathname.endsWith('.m3u8'))
      return playlist(...bodies.flatMap((_, i) => segment(`s${i}.ts`)))
    await sleep(10)
    return bodies[Number(url.pathname.match(/s(\d+)/)[1])]
  }
  const f = fixture(t, serve)
  const gid = await f.add('video.ts', 'https://example.test/index.m3u8?sign=secret-old')
  await until(() => f.driver.status(gid).completedLength >= 200)
  await f.driver.pause(gid)
  const parts = join(f.dir, '.video.ts.hls-parts')
  const json = readFileSync(join(parts, 'metadata.json'), 'utf8')
  assert.ok(!json.includes('secret-old') && !json.includes('secret-cookie'))
  const metadata = JSON.parse(json)
  const files = Object.keys(metadata.files)
  assert.ok(files.length >= 2)
  writeFileSync(join(parts, files[0]), Buffer.alloc(100, 255))
  await f.driver.destroy()
  const next = fixture(t, serve, f.dir)
  const status = await next.finish(
    await next.add('video.ts', 'https://example.test/index.m3u8?sign=secret-new')
  )
  assert.equal(status.status, 'complete', status.errorMessage)
  assert.deepEqual(readFileSync(status.files[0].path), Buffer.concat(bodies))
  assert.ok(next.hits.includes(`/s${Number(files[0].split('.')[0])}.ts`))
  for (const file of files.slice(1)) {
    assert.ok(!next.hits.includes(`/s${Number(file.split('.')[0])}.ts`), '有效分片不应重新下载')
  }
})

test('鉴权参数之外的内容参数变化使旧元数据失效', async (t) => {
  let blocked = true
  const f = fixture(t, async (url) => {
    if (url.pathname.endsWith('.m3u8')) return playlist(...segment('a.ts'), ...segment('b.ts'))
    if (url.pathname === '/b.ts' && blocked) {
      await sleep(30)
      throw new Error('模拟断线')
    }
    return url.searchParams.get('content') === 'new' ? 'NEW' : 'OLD'
  })
  const first = await f.finish(
    await f.add('video.ts', 'https://example.test/index.m3u8?content=old')
  )
  assert.equal(first.status, 'error')
  await f.driver.destroy()
  blocked = false
  const next = fixture(
    t,
    (url) =>
      url.pathname.endsWith('.m3u8') ? playlist(...segment('a.ts'), ...segment('b.ts')) : 'NEW',
    f.dir
  )
  const result = await next.finish(
    await next.add('video.ts', 'https://example.test/index.m3u8?content=new')
  )
  assert.equal(result.status, 'complete', result.errorMessage)
  assert.equal(readFileSync(result.files[0].path, 'utf8'), 'NEWNEW')
  assert.ok(next.hits.includes('/a.ts'))
})

test('没有 FFmpeg 时分轨提前失败，不输出无声视频', async (t) => {
  const f = fixture(t, (url) =>
    url.pathname === '/index.m3u8'
      ? [
          '#EXTM3U',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="default",DEFAULT=YES,URI="audio.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
          'video.m3u8'
        ].join('\n')
      : playlist(...segment('a.ts'))
  )
  const status = await f.finish(await f.add())
  assert.equal(status.status, 'error')
  assert.match(status.errorMessage, /FFmpeg/)
  assert.ok(!f.hits.includes('/a.ts'))
})
