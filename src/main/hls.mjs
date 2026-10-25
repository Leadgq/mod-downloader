import { randomUUID, createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const PARTS_SUFFIX = '.hls-parts'
const pad = (index) => String(index).padStart(6, '0')

export function isHlsUri(uri) {
  try {
    return new URL(uri).pathname.toLowerCase().endsWith('.m3u8')
  } catch {
    return false
  }
}

function parseAttributes(input) {
  const attrs = {}
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let match
  while ((match = pattern.exec(input))) {
    const raw = match[2]
    attrs[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw
  }
  return attrs
}

function parseRangeValue(value, lastEnd) {
  if (!value) return null
  const [length, offset] = value.split('@')
  const start =
    offset === undefined || offset === '' ? (lastEnd >= 0 ? lastEnd + 1 : 0) : Number(offset)
  return { offset: start, length: Number(length) }
}

export function parseM3u8(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  const variants = []
  const segments = []
  let mediaSequence = 0
  let live = true
  let key = null
  let map = null
  let pendingDuration = 0
  let pendingRange = null
  let pendingVariant = null
  let lastRangeEnd = -1
  for (const line of lines) {
    if (!line) continue
    if (!line.startsWith('#')) {
      if (pendingVariant) {
        pendingVariant.uri = line
        pendingVariant = null
      } else {
        const byteRange = pendingRange
        if (byteRange) lastRangeEnd = byteRange.offset + byteRange.length - 1
        segments.push({ uri: line, duration: pendingDuration, byteRange, key, map })
      }
      pendingDuration = 0
      pendingRange = null
      continue
    }
    const colon = line.indexOf(':')
    const tag = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1)
    if (tag === '#EXT-X-STREAM-INF') {
      const attrs = parseAttributes(value)
      const variant = { uri: '', bandwidth: Number(attrs.BANDWIDTH) || 0, attrs }
      variants.push(variant)
      pendingVariant = variant
    } else if (tag === '#EXTINF') {
      pendingDuration = parseFloat(value) || 0
    } else if (tag === '#EXT-X-BYTERANGE') {
      pendingRange = parseRangeValue(value, lastRangeEnd)
    } else if (tag === '#EXT-X-KEY') {
      const attrs = parseAttributes(value)
      key = attrs.METHOD && attrs.METHOD !== 'NONE' ? { ...attrs } : null
    } else if (tag === '#EXT-X-MAP') {
      const attrs = parseAttributes(value)
      map = attrs.URI ? { uri: attrs.URI, byteRange: attrs.BYTERANGE || null } : map
    } else if (tag === '#EXT-X-MEDIA-SEQUENCE') {
      mediaSequence = Number(value) || 0
    } else if (tag === '#EXT-X-ENDLIST') {
      live = false
    }
  }
  return {
    isMaster: variants.length > 0,
    variants,
    segments,
    mediaSequence,
    live,
    map: segments[0]?.map || null
  }
}

// 相对地址基于播放列表解析；同源且自身没有查询串时继承列表的查询串
// （签名型 CDN 的 sign 参数需要带到每个分片和密钥请求上）。
export function resolveSource(ref, baseUrl) {
  const url = new URL(ref, baseUrl)
  const base = new URL(baseUrl)
  if (!url.search && base.search && url.origin === base.origin) url.search = base.search
  return url.toString()
}

function httpMessage(status) {
  if (status === 401 || status === 403)
    return '服务器拒绝访问（403）：Cookie 缺失或失效，或链接签名已过期'
  if (status === 404 || status === 410) return '资源不存在（404）：链接可能已过期'
  if (status === 429) return '请求过于频繁（429）'
  if (status >= 500) return `服务器错误（${status}）`
  return `请求失败（${status}）`
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('已中止')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function ivBuffer(ivHex, sequence) {
  const hex = ivHex ? ivHex.replace(/^0[xX]/, '') : sequence.toString(16)
  return Buffer.from(hex.padStart(32, '0'), 'hex')
}

function aesDecrypt(buffer, key, iv) {
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([decipher.update(buffer), decipher.final()])
  } catch {
    // 少数打包器不分段填充 PKCS7，回退为去掉自动去填充直接解密
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    decipher.setAutoPadding(false)
    try {
      return Buffer.concat([decipher.update(buffer), decipher.final()])
    } catch {
      throw new Error('分片解密失败（数据长度异常）')
    }
  }
}

function sanitizeName(name) {
  const printable = [...name].map((char) => (char.charCodeAt(0) < 32 ? '_' : char)).join('')
  return printable
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i, '_$&')
}

function targetName(task, playlistUrl, ext) {
  const provided = String(task.filename || '').trim()
  if (provided) return /\.[a-z0-9]{1,5}$/i.test(provided) ? provided : `${provided}${ext}`
  let base = ''
  try {
    base = decodeURIComponent(new URL(playlistUrl).pathname.split('/').pop() || '')
  } catch {
    base = ''
  }
  base = sanitizeName(base.replace(/\.m3u8?$/i, ''))
  return `${base || 'hls-download'}${ext}`
}

export function createHlsDriver({
  fetchImpl = fetch,
  userAgent = BROWSER_USER_AGENT,
  maxRetries = 3,
  maxSegmentAttempts = 6,
  errorBackoffBaseMs = 1000,
  errorBackoffMaxMs = 8000,
  ffmpegPath = ''
} = {}) {
  const jobs = new Map()

  function partPath(job, index) {
    return join(job.partsDir, `${pad(index)}.part`)
  }

  async function request(job, url, range) {
    const headers = { 'User-Agent': userAgent }
    if (job.cookie) headers.Cookie = job.cookie
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchImpl(url, {
          headers,
          signal: job.controller.signal,
          redirect: 'follow'
        })
        if (!response.ok) {
          const error = new Error(httpMessage(response.status))
          error.statusCode = response.status
          error.fatal = [401, 403, 404, 410].includes(response.status)
          throw error
        }
        return response
      } catch (error) {
        if (error.name === 'AbortError') throw error
        lastError = error
        if (error.fatal) throw error
        if (attempt < maxRetries) await abortableSleep(300 * 2 ** attempt, job.controller.signal)
      }
    }
    throw lastError
  }

  async function fetchPlaylist(job, url) {
    const response = await request(job, url)
    const text = await response.text()
    const trimmed = text.replace(/^\uFEFF/, '').trimStart()
    if (!trimmed.startsWith('#EXTM3U')) {
      if (trimmed.startsWith('<') || /<html|<!doctype/i.test(trimmed.slice(0, 200)))
        throw new Error(
          '获取到的是网页而不是播放列表：请在高级设置里填写浏览器 Cookie（网页 F12 → 网络 → 任意请求 → 复制 Cookie），并确认链接未过期'
        )
      throw new Error('播放列表内容无法识别，可能需要 Cookie 或链接已过期')
    }
    return { text, url: response.url || url }
  }

  async function loadKey(job, keyUrl) {
    if (job.keys.has(keyUrl)) return job.keys.get(keyUrl)
    const response = await request(job, keyUrl)
    const key = Buffer.from(await response.arrayBuffer())
    if (key.length !== 16) throw new Error(`密钥长度异常（${key.length} 字节）`)
    job.keys.set(keyUrl, key)
    return key
  }

  async function preparePlan(job) {
    let url = job.task.uri
    for (let depth = 0; depth < 3; depth++) {
      const { text, url: finalUrl } = await fetchPlaylist(job, url)
      const playlist = parseM3u8(text)
      if (playlist.isMaster) {
        const best = playlist.variants
          .filter((variant) => variant.uri)
          .sort((a, b) => b.bandwidth - a.bandwidth)[0]
        if (!best) throw new Error('播放列表里没有可用的流')
        url = resolveSource(best.uri, finalUrl)
        continue
      }
      if (!playlist.segments.length) throw new Error('播放列表里没有分片')
      if (playlist.live) throw new Error('这是直播流（播放列表未结束），暂不支持下载直播')
      const unsupported = playlist.segments.find(
        (segment) => segment.key && segment.key.METHOD !== 'AES-128'
      )
      if (unsupported)
        throw new Error(`暂不支持该流的加密方式（${unsupported.key.METHOD}），无法下载`)

      const initSegment = playlist.map
        ? {
            url: resolveSource(playlist.map.uri, finalUrl),
            range: parseRangeValue(playlist.map.byteRange, -1),
            key: playlist.segments[0].key || null
          }
        : null
      const segments = playlist.segments.map((segment, index) => ({
        url: resolveSource(segment.uri, finalUrl),
        range: segment.byteRange,
        key:
          segment.key && segment.key.URI
            ? { url: resolveSource(segment.key.URI, finalUrl), iv: segment.key.IV || '' }
            : null,
        sequence: playlist.mediaSequence + index
      }))
      const ext = initSegment ? '.mp4' : '.ts'
      // 命名跟随用户填写的原始链接：主播放列表跳转到变体后，变体名往往是 CDN 内部名
      const name = targetName(job.task, job.task.uri, ext)
      const finalPath = join(job.task.dir, name)
      if (existsSync(finalPath))
        throw new Error(`目标文件已存在：${name}，请换一个文件名或先移走原文件`)
      const partsDir = join(job.task.dir, `.${name}${PARTS_SUFFIX}`)
      mkdirSync(partsDir, { recursive: true })
      if (initSegment) {
        const initPart = join(partsDir, 'init.part')
        if (!existsSync(initPart)) {
          let buffer = Buffer.from(
            await (await request(job, initSegment.url, initSegment.range)).arrayBuffer()
          )
          if (initSegment.key) {
            const key = await loadKey(job, initSegment.key.url)
            buffer = aesDecrypt(buffer, key, ivBuffer(initSegment.key.iv, playlist.mediaSequence))
          }
          const tmp = `${initPart}.tmp`
          await writeFile(tmp, buffer)
          await rename(tmp, initPart)
          job.completedBytes += buffer.length
        }
      }
      job.plan = { segments, total: segments.length }
      job.partsDir = partsDir
      job.finalPath = finalPath
      job.totalEstimate = 0
      scanParts(job)
      return
    }
    throw new Error('播放列表嵌套层级过多，无法解析')
  }

  function scanParts(job) {
    job.doneSet = new Set()
    job.completedBytes = job.plan.segments.reduce((sum, _segment, index) => {
      const part = partPath(job, index)
      if (!existsSync(part)) return sum
      const size = statSync(part).size
      if (size <= 0) return sum
      job.doneSet.add(index)
      return sum + size
    }, job.completedBytes)
    job.done = job.doneSet.size
    job.cursor = 0
    refreshEstimate(job)
  }

  function refreshEstimate(job) {
    if (job.done <= 0 || job.plan.total <= 0) return
    const estimate = (job.completedBytes / job.done) * job.plan.total
    if (estimate > job.totalEstimate) job.totalEstimate = estimate
  }

  async function downloadSegment(job, index) {
    const segment = job.plan.segments[index]
    let buffer = Buffer.from(await (await request(job, segment.url, segment.range)).arrayBuffer())
    if (segment.key) {
      const key = await loadKey(job, segment.key.url)
      buffer = aesDecrypt(buffer, key, ivBuffer(segment.key.iv, segment.sequence))
    }
    const part = partPath(job, index)
    const tmp = `${part}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, buffer)
    await rename(tmp, part)
    job.doneSet.add(index)
    job.done++
    job.completedBytes += buffer.length
    refreshEstimate(job)
  }

  async function merge(job) {
    const temp = `${job.finalPath}.merging`
    rmSync(temp, { force: true })
    const out = createWriteStream(temp)
    try {
      for (let index = 0; index < job.plan.total; index++) {
        if (!job.doneSet.has(index)) throw new Error('分片缺失，无法合并')
        const buffer = await readFile(partPath(job, index))
        if (!out.write(buffer)) await once(out, 'drain')
      }
      out.end()
      await once(out, 'finish')
      try {
        await rename(temp, job.finalPath)
      } catch {
        rmSync(temp, { force: true })
        throw new Error(`目标文件已存在：${job.finalPath}`)
      }
      job.totalEstimate = job.completedBytes
      rmSync(job.partsDir, { recursive: true, force: true })
    } catch (error) {
      out.destroy()
      rmSync(temp, { force: true })
      throw error
    }
  }

  function runFfmpeg(args) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
      })
      child.on('error', () => resolve({ ok: false, stderr: '' }))
      child.on('close', (code) => resolve({ ok: code === 0, stderr }))
    })
  }

  // 合并出 .ts 后，若内置 ffmpeg 可用则无损转封装为 .m4a/.mp4，方便手机直接播放。
  // 转封装失败不致命：保留 .ts，任务照常完成。
  async function remux(job) {
    if (!ffmpegPath || !existsSync(ffmpegPath) || !job.finalPath.endsWith('.ts')) return
    // -i 不带输出参数时 ffmpeg 必然报错退出，但 stderr 里带完整的流信息
    const probe = await runFfmpeg(['-hide_banner', '-i', job.finalPath])
    const hasVideo = /Stream #\d+:\d+.*: Video:/.test(probe.stderr)
    const target = job.finalPath.replace(/\.ts$/, hasVideo ? '.mp4' : '.m4a')
    if (existsSync(target)) return
    const temp = `${target}.remuxing`
    rmSync(temp, { force: true })
    // 输出格式显式指定（ipod 即 m4a），临时文件的后缀 ffmpeg 不认识
    const result = await runFfmpeg([
      '-y',
      '-hide_banner',
      '-i',
      job.finalPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-f',
      hasVideo ? 'mp4' : 'ipod',
      temp
    ])
    if (!result.ok) {
      rmSync(temp, { force: true })
      return
    }
    try {
      await rename(temp, target)
      rmSync(job.finalPath, { force: true })
      job.finalPath = target
      job.completedBytes = statSync(target).size
      job.totalEstimate = job.completedBytes
    } catch {
      rmSync(temp, { force: true })
    }
  }

  // 领取下一个未完成的分片；优先重试此前失败被回队的分片
  function takeSegment(job) {
    if (job.retries.length) return job.retries.shift()
    while (job.cursor < job.plan.total && job.doneSet.has(job.cursor)) job.cursor++
    return job.cursor < job.plan.total ? job.cursor++ : -1
  }

  // 线路不稳（连接中断、字节不完整等）时降并发；连续成功后逐级恢复。
  // 重试等待按“分片自身第几次失败”指数增长，分片之间互不拖累
  function throttleDown(job) {
    job.successStreak = 0
    job.currentLimit = Math.max(1, Math.floor(job.currentLimit / 2))
  }

  function throttleRecover(job) {
    if (job.currentLimit >= job.baseLimit) return
    if (job.successStreak < job.currentLimit * 6) return
    job.currentLimit = Math.min(job.baseLimit, job.currentLimit * 2)
    job.successStreak = 0
  }

  async function worker(job) {
    job.activeWorkers++
    try {
      while (job.status === 'active' && !job.controller.signal.aborted) {
        // 已被降速时，多出来的 worker 主动退出
        if (job.activeWorkers > job.currentLimit) break
        const index = takeSegment(job)
        if (index < 0) break
        try {
          await downloadSegment(job, index)
          job.successStreak++
          throttleRecover(job)
        } catch (error) {
          if (error.name === 'AbortError') throw error
          job.attempts[index] = (job.attempts[index] || 0) + 1
          if (job.attempts[index] >= job.maxSegmentAttempts) {
            job.status = 'error'
            job.errorMessage = `分片 ${index + 1} 连续下载失败：${error.message}`
            throw error
          }
          throttleDown(job)
          job.retries.push(index)
          await abortableSleep(
            Math.min(errorBackoffMaxMs, errorBackoffBaseMs * 2 ** (job.attempts[index] - 1)),
            job.controller.signal
          )
        }
      }
    } finally {
      job.activeWorkers--
    }
  }

  function start(job) {
    if (job.running) return null
    job.running = true
    job.runPromise = execute(job).finally(() => {
      job.running = false
      job.activeWorkers = 0
    })
    return job.runPromise
  }

  async function execute(job) {
    try {
      if (!job.plan) await preparePlan(job)
      job.baseLimit = Math.min(16, Math.max(1, Math.floor(job.task.connectionsLimit) || 8))
      job.currentLimit = job.currentLimit || job.baseLimit
      // worker 失败后会把分片回队；轮次循环保证回队的分片被重新领走
      for (let round = 0; round < 100; round++) {
        if (job.status !== 'active' || job.controller.signal.aborted) return
        if (job.done >= job.plan.total) break
        job.cursor = 0
        const count = Math.max(
          1,
          Math.min(job.currentLimit, job.plan.total - job.done + job.retries.length)
        )
        await Promise.all(Array.from({ length: count }, () => worker(job)))
        if (job.done >= job.plan.total) break
        if (job.status !== 'active' || job.controller.signal.aborted) return
        // 有分片仍差着：歇一口气再开下一轮
        await abortableSleep(errorBackoffBaseMs, job.controller.signal)
      }
      if (job.status !== 'active' || job.controller.signal.aborted) return
      if (job.done >= job.plan.total) {
        job.totalEstimate = Math.max(job.totalEstimate, job.completedBytes)
        await merge(job)
        await remux(job)
        job.status = 'complete'
      } else {
        // 有分片始终没下下来（不应发生），避免任务卡在 active
        job.status = 'error'
        job.errorMessage = '部分分片未能下载，请重试任务'
      }
    } catch (error) {
      if (job.status !== 'paused' && error.name !== 'AbortError') {
        job.status = 'error'
        // worker 内部已写过更具体的原因（如分片失败次数达上限）时不要覆盖
        job.errorMessage ||= error.message || '下载失败'
      }
    }
  }

  function snapshot(job, now) {
    if (job.status === 'active') {
      const sample = job.lastSample
      if (sample.time) {
        const seconds = (now - sample.time) / 1000
        if (seconds > 0.25) {
          const instant = Math.max(0, (job.completedBytes - sample.bytes) / seconds)
          job.speed = job.speed ? job.speed * 0.6 + instant * 0.4 : instant
          job.lastSample = { time: now, bytes: job.completedBytes }
        }
      } else {
        job.lastSample = { time: now, bytes: job.completedBytes }
      }
    }
    const total = Math.max(job.totalEstimate, job.completedBytes)
    return {
      status: job.status,
      totalLength: total,
      completedLength: job.completedBytes,
      downloadSpeed: job.status === 'active' ? Math.round(job.speed) : 0,
      connections: job.status === 'active' ? job.activeWorkers : 0,
      errorMessage: job.errorMessage,
      files: [{ path: job.finalPath }]
    }
  }

  function findJob(gid) {
    const job = jobs.get(gid)
    if (!job) throw new Error('下载任务不存在或已结束')
    return job
  }

  return {
    isHls: true,
    // HLS 下载在进程内完成，没有外部引擎进程
    setFailureHandler() {},
    async ensure() {},
    async add(task, cookie) {
      const gid = `hls:${randomUUID()}`
      const ext = '.ts'
      jobs.set(gid, {
        gid,
        task,
        cookie: cookie || '',
        controller: new AbortController(),
        status: 'active',
        errorMessage: '',
        finalPath: join(task.dir, targetName(task, task.uri, ext)),
        partsDir: '',
        plan: null,
        keys: new Map(),
        doneSet: new Set(),
        done: 0,
        cursor: 0,
        retries: [],
        attempts: {},
        baseLimit: 0,
        currentLimit: 0,
        successStreak: 0,
        maxSegmentAttempts,
        completedBytes: 0,
        totalEstimate: 0,
        speed: 0,
        lastSample: { time: 0, bytes: 0 },
        activeWorkers: 0,
        running: false,
        runPromise: null
      })
      void start(jobs.get(gid))
      return gid
    },
    status(gid) {
      return snapshot(findJob(gid), Date.now())
    },
    async pause(gid) {
      const job = findJob(gid)
      if (job.status !== 'active') return snapshot(job, Date.now())
      job.status = 'paused'
      job.controller.abort()
      if (job.runPromise) await job.runPromise.catch(() => {})
      return snapshot(job, Date.now())
    },
    async resume(gid) {
      const job = findJob(gid)
      if (job.status !== 'paused') return
      job.controller = new AbortController()
      job.status = 'active'
      job.errorMessage = ''
      job.lastSample = { time: 0, bytes: 0 }
      void start(job)
    },
    async remove(gid) {
      const job = jobs.get(gid)
      if (!job) return
      job.status = job.status === 'complete' ? job.status : 'cancelled'
      job.controller.abort()
      jobs.delete(gid)
    },
    async destroy() {
      for (const job of jobs.values()) job.controller.abort()
      jobs.clear()
    }
  }
}
