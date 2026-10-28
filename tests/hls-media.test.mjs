import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHlsDriver } from '../src/main/hls.mjs'

const ffmpeg = fileURLToPath(new URL('../resources/bin/win32/ffmpeg.exe', import.meta.url))
const ffprobe = fileURLToPath(new URL('../resources/bin/win32/ffprobe.exe', import.meta.url))
const skip = !existsSync(ffmpeg) || !existsSync(ffprobe)
let fixtures
function command(exe, args, cwd) {
  const result = spawnSync(exe, args, { windowsHide: true, timeout: 30000, encoding: 'utf8', cwd })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  return result.stdout
}
function createFixtures() {
  if (fixtures) return fixtures
  const dir = mkdtempSync(join(tmpdir(), 'hls-real-media-'))
  for (const [name, type] of [
    ['av', 'both'],
    ['video', 'video'],
    ['audio', 'audio'],
    ['other', 'both']
  ]) {
    const folder = join(dir, name)
    mkdirSync(folder)
    const args = ['-y', '-hide_banner', '-loglevel', 'error']
    if (type !== 'audio') args.push('-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=10')
    if (type !== 'video') args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000')
    args.push('-t', '2')
    if (type !== 'audio')
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-sc_threshold', '0')
    if (type !== 'video') args.push('-c:a', 'aac')
    args.push(
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_segment_filename',
      join(folder, 's%02d.m4s'),
      join(folder, 'index.m3u8')
    )
    command(ffmpeg, args, folder)
  }
  fixtures = dir
  return dir
}
async function download(t, master, limit = 2) {
  const mediaDir = createFixtures()
  const dir = mkdtempSync(join(tmpdir(), 'hls-real-output-'))
  const hits = []
  let active = 0
  let peak = 0
  const driver = createHlsDriver({
    ffmpegPath: ffmpeg,
    maxRetries: 0,
    maxSegmentAttempts: 1,
    fetchImpl: async (uri) => {
      const path = new URL(uri).pathname
      hits.push(path)
      if (path === '/master.m3u8') return new Response(master(mediaDir))
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, 5))
        const local = resolve(mediaDir, `.${path}`)
        assert.ok(local.startsWith(`${mediaDir}\\`) || local.startsWith(`${mediaDir}/`))
        return new Response(readFileSync(local))
      } finally {
        active--
      }
    }
  })
  t.after(() => driver.destroy())
  const gid = await driver.add({
    uri: 'https://example.test/master.m3u8',
    dir,
    filename: 'video.mp4',
    connectionsLimit: limit
  })
  for (let i = 0; i < 2000 && driver.status(gid).status === 'active'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const status = driver.status(gid)
  assert.equal(status.status, 'complete', status.errorMessage)
  const file = status.files[0].path
  const info = JSON.parse(
    command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])
  )
  command(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'])
  assert.deepEqual(info.streams.map((item) => item.codec_type).sort(), ['audio', 'video'])
  assert.ok(peak <= limit, `所有轨道共享并发限制，实际 ${peak} > ${limit}`)
  return { info, hits, dir, file }
}

test('真实 fMP4：初始化段加入最终文件，音视频均可解码', { skip }, async (t) => {
  const result = await download(t, () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nav/index.m3u8')
  assert.ok(Number(result.info.format.duration) >= 1.9)
  assert.equal(existsSync(join(result.dir, '.video.mp4.hls-parts')), false)
})

test('真实分轨：选默认音轨、排除 I-frame 变体，合成带声音的 MP4', { skip }, async (t) => {
  const result = await download(t, () =>
    [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="unused",URI="missing.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="default",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=9999999,URI="missing-iframe.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"',
      'video/index.m3u8'
    ].join('\n')
  )
  assert.ok(result.hits.includes('/audio/index.m3u8'))
  assert.ok(!result.hits.some((path) => path.includes('missing')))
  assert.ok(Math.abs(Number(result.info.format.duration) - 2) < 0.2)
})

test('真实 Map 切换：不连续时间轴的两段 fMP4 合成后均保留', { skip }, async (t) => {
  const result = await download(t, (dir) => {
    const body = (name) =>
      readFileSync(join(dir, name, 'index.m3u8'), 'utf8')
        .split(/\r?\n/)
        .filter(
          (line) =>
            line &&
            !/^#EXT(M3U|-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|ENDLIST))/.test(
              line
            )
        )
        .map((line) =>
          line.startsWith('#EXT-X-MAP:')
            ? line.replace('init.mp4', `${name}/init.mp4`)
            : line.startsWith('#')
              ? line
              : `${name}/${line}`
        )
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:1',
      ...body('av'),
      '#EXT-X-DISCONTINUITY',
      ...body('other'),
      '#EXT-X-ENDLIST'
    ].join('\n')
  })
  assert.ok(result.hits.includes('/av/init.mp4'))
  assert.ok(result.hits.includes('/other/init.mp4'))
  assert.ok(Number(result.info.format.duration) >= 3.9, result.info.format.duration)
})
