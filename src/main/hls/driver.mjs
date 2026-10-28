import { randomUUID, createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { link, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseM3u8 } from './playlist.mjs'
import { digest, openStorage, resourceIdentity } from './storage.mjs'

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
    throw new Error('分片解密失败（密钥、IV 或加密数据不正确）')
  }
}

function sanitizeName(name) {
  const printable = [...name].map((char) => (char.charCodeAt(0) < 32 ? '_' : char)).join('')
  return printable
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i, '_$&')
}

// 文件名主体上限：给扩展名、分片目录后缀和保存路径留足余量，
// Windows 默认整路径 260 字符，超长会直接写入失败
const MAX_NAME_BASE = 72

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
  // 按码点截断（避免劈开代理对），哈希尾巴防止不同长名截断后撞车
  if (base.length > MAX_NAME_BASE) {
    const chars = [...base]
    base = `${chars
      .slice(0, MAX_NAME_BASE - 7)
      .join('')
      .trimEnd()}~${digest(base).slice(0, 6)}`
  }
  return `${base || 'hls-download'}${ext}`
}

export function createHlsDriver({
  fetchImpl = fetch,
  spawnImpl = spawn,
  userAgent = BROWSER_USER_AGENT,
  maxRetries = 3,
  maxSegmentAttempts = 6,
  errorBackoffBaseMs = 1000,
  errorBackoffMaxMs = 8000,
  ffmpegTimeoutMs = 10 * 60 * 1000,
  ffmpegPath = '',
  debugLogPath = ''
} = {}) {
  const jobs = new Map()

  // 诊断日志：分片成败、调速变化全记录，排查"卡住不动"类问题用
  let logSize = 0
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`
    if (debugLogPath) {
      try {
        if (logSize > 5 * 1024 * 1024) {
          rmSync(debugLogPath, { force: true })
          logSize = 0
        }
        appendFileSync(debugLogPath, line, 'utf8')
        logSize += line.length
      } catch {
        /* 日志失败不影响下载 */
      }
    }
  }

  async function request(job, url, range) {
    const headers = { 'User-Agent': userAgent, Connection: 'close', 'Accept-Encoding': 'identity' }
    if (job.cookie) headers.Cookie = job.cookie
    if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let reportedProgress = false
        const response = await fetchImpl(url, {
          headers,
          signal: job.controller.signal,
          onProgress: (bytes) => {
            reportedProgress = true
            job.transferredBytes += bytes
          },
          redirect: 'follow'
        })
        if (!response.ok) {
          const error = new Error(httpMessage(response.status))
          error.statusCode = response.status
          error.fatal = [401, 403, 404, 410].includes(response.status)
          throw error
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        job.controller.signal.throwIfAborted()
        const length = response.headers?.get('content-length')
        const encoding = response.headers?.get('content-encoding')
        if (length !== null && length !== undefined && (!encoding || encoding === 'identity')) {
          if (!/^\d+$/.test(length) || Number(length) !== buffer.length) {
            throw new Error('响应长度与 Content-Length 不一致')
          }
        }
        if (!buffer.length) throw new Error('服务器返回了空内容')
        if (range) {
          const contentRange = response.headers?.get('content-range') || ''
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
          const end = range.offset + range.length - 1
          if (
            response.status !== 206 ||
            !match ||
            Number(match[1]) !== range.offset ||
            Number(match[2]) !== end ||
            (match[3] !== '*' && Number(match[3]) <= end) ||
            buffer.length !== range.length
          )
            throw new Error('服务器未正确返回请求的字节范围（需要匹配的 206 / Content-Range）')
        } else if (response.status === 206) {
          throw new Error('服务器意外返回了不完整的范围响应')
        }
        if (!reportedProgress) job.transferredBytes += buffer.length
        return { buffer, url: response.url || url }
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
    const text = response.buffer.toString('utf8')
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

  async function loadKey(job, descriptor) {
    if (!job.keys.has(descriptor.id)) {
      const pending = request(job, descriptor.url).then(({ buffer }) => {
        if (buffer.length !== 16) throw new Error(`密钥长度异常（${buffer.length} 字节）`)
        return buffer
      })
      job.keys.set(descriptor.id, pending)
      pending.catch(() => job.keys.delete(descriptor.id))
    }
    return job.keys.get(descriptor.id)
  }

  function keyDescriptor(key, baseUrl, trackId, isMap = false) {
    if (!key) return null
    if (key.METHOD !== 'AES-128' || key.KEYFORMAT !== 'identity') {
      throw new Error(`暂不支持该流的加密方式（${key.METHOD} / ${key.KEYFORMAT}）`)
    }
    if (isMap && !key.IV) throw new Error('加密初始化段必须提供显式 IV')
    const url = resolveSource(key.URI, baseUrl)
    return { url, iv: key.IV, id: `${trackId}:${key.epoch}:${url}` }
  }

  async function loadTrack(job, url, id, depth = 0) {
    if (depth >= 5) throw new Error('播放列表嵌套层级过多，无法解析')
    const { text, url: finalUrl } = await fetchPlaylist(job, url)
    const playlist = parseM3u8(text)
    if (playlist.isMaster) {
      const variant = playlist.variants
        .filter((item) => item.uri && !item.isIFrameOnly)
        .sort((a, b) => b.bandwidth - a.bandwidth)[0]
      if (!variant) throw new Error('播放列表里没有可用的完整流')
      const tracks = await loadTrack(job, resolveSource(variant.uri, finalUrl), id, depth + 1)
      const audio =
        variant.audio.find((item) => item.isDefault) ||
        variant.audio.find((item) => item.autoselect) ||
        variant.audio[0]
      // 无 URI 的 AUDIO 声明表示音频已包含在主流中，不另建下载任务。
      if (audio?.uri) {
        if (tracks.length > 1) throw new Error('嵌套列表包含重复的独立音轨')
        const audioTracks = await loadTrack(
          job,
          resolveSource(audio.uri, finalUrl),
          'audio',
          depth + 1
        )
        if (audioTracks.length !== 1) throw new Error('独立音轨不能再包含分轨主列表')
        tracks.push(audioTracks[0])
      }
      return tracks
    }
    if (playlist.live) throw new Error('这是直播流（播放列表未结束），暂不支持下载直播')
    if (playlist.isIFrameOnly) throw new Error('仅关键帧播放列表不能作为完整视频下载')
    if (!playlist.segments.length) throw new Error('播放列表里没有分片')
    const maps = new Map()
    const segments = playlist.segments.map((segment) => {
      if (segment.gap) throw new Error('播放列表包含缺失分片（EXT-X-GAP），无法完整下载')
      let map = null
      if (segment.map) {
        const value = segment.map
        if (!maps.has(value.epoch)) {
          maps.set(value.epoch, {
            url: resolveSource(value.uri, finalUrl),
            range: value.byteRange,
            key: keyDescriptor(value.key, finalUrl, id, true),
            sequence: 0,
            isMap: true,
            file: `${id}-map-${pad(value.epoch)}.part`
          })
        }
        map = maps.get(value.epoch)
      }
      return {
        url: resolveSource(segment.uri, finalUrl),
        range: segment.byteRange,
        key: keyDescriptor(segment.key, finalUrl, id),
        sequence: segment.sequence,
        duration: segment.duration,
        discontinuity: segment.discontinuity,
        map,
        trackId: id
      }
    })
    return [{ id, url: finalUrl, segments, maps: [...maps.values()] }]
  }

  async function preparePlan(job) {
    const tracks = await loadTrack(job, job.task.uri, 'main')
    const segments = tracks.flatMap((track) => track.segments)
    const maps = tracks.flatMap((track) => track.maps)
    segments.forEach((segment, index) => {
      segment.file = `${pad(index)}.part`
    })
    const needsMux =
      tracks.length > 1 ||
      tracks.some(
        (track) =>
          new Set(track.segments.map((segment) => segment.map?.file)).size > 1 ||
          track.segments.some((segment) => segment.discontinuity)
      )
    if (needsMux && (!ffmpegPath || !existsSync(ffmpegPath))) {
      throw new Error('此播放列表需要 FFmpeg 合成音轨或处理初始化段切换，请安装项目内置 FFmpeg')
    }
    const resources = [...segments, ...maps]
    // 在决定复用分片前验证实际 Key，避免同 URI 的密钥轮换或继续下载时的旧缓存。
    for (const resource of resources) {
      job.controller.signal.throwIfAborted()
      const keyHash = resource.key ? digest(await loadKey(job, resource.key)) : null
      resource.identity = digest(
        JSON.stringify({
          url: resourceIdentity(resource.url),
          range: resource.range,
          sequence: resource.sequence,
          duration: resource.duration || 0,
          discontinuity: Boolean(resource.discontinuity),
          key: resource.key ? { hash: keyHash, iv: resource.key.iv } : null,
          map: resource.map
            ? {
                url: resourceIdentity(resource.map.url),
                range: resource.map.range,
                key: resource.map.key
                  ? {
                      hash: digest(await loadKey(job, resource.map.key)),
                      iv: resource.map.key.iv
                    }
                  : null
              }
            : null
        })
      )
    }
    const ext = maps.length || needsMux ? '.mp4' : '.ts'
    let name = targetName(job.task, job.task.uri, ext)
    if (ext === '.mp4' && !/\.(mp4|m4a)$/i.test(name)) name = name.replace(/\.[^.]+$/, '.mp4')
    const finalPath = join(job.task.dir, name)
    if (existsSync(finalPath))
      throw new Error(`目标文件已存在：${name}，请换一个文件名或先移走原文件`)
    const partsDir = join(job.task.dir, `.${name}${PARTS_SUFFIX}`)
    mkdirSync(partsDir, { recursive: true })
    job.plan = { tracks, segments, resources, needsMux, total: resources.length }
    job.partsDir = partsDir
    job.finalPath = finalPath
    const identity = digest(
      JSON.stringify({
        source: resourceIdentity(job.task.uri),
        tracks: tracks.map((track) => ({ id: track.id, url: resourceIdentity(track.url) })),
        resources: resources.map((resource) => resource.identity)
      })
    )
    job.storage = await openStorage(partsDir, identity, resources, job.controller.signal)
    job.doneSet = job.storage.done
    job.done = job.doneSet.size
    job.completedBytes = job.storage.bytes
    job.cursor = 0
    refreshEstimate(job)
  }

  function refreshEstimate(job) {
    if (job.done <= 0 || job.plan.total <= 0) return
    const estimate = (job.completedBytes / job.done) * job.plan.total
    if (estimate > job.totalEstimate) job.totalEstimate = estimate
  }

  async function downloadSegment(job, index) {
    const segment = job.plan.resources[index]
    const startedAt = Date.now()
    let { buffer } = await request(job, segment.url, segment.range)
    if (segment.key) {
      const key = await loadKey(job, segment.key)
      buffer = aesDecrypt(buffer, key, ivBuffer(segment.key.iv, segment.sequence))
    }
    if (!buffer.length) throw new Error('分片解密后内容为空')
    if (
      /^\s*(?:<!doctype\s+html|<html|<head|<body)\b/i.test(buffer.subarray(0, 256).toString('utf8'))
    ) {
      throw new Error('分片返回了 HTML 验证页面，请检查 Cookie 或链接有效期')
    }
    await job.storage.commit(index, buffer)
    job.doneSet.add(index)
    job.done++
    job.completedBytes += buffer.length
    refreshEstimate(job)
    log(`${job.gid} 分片${index} 完成 (${Date.now() - startedAt}ms, ${buffer.length}字节)`)
  }

  function runFfmpeg(job, args, allowFailure = false) {
    job.controller.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = spawnImpl(ffmpegPath, ['-nostdin', '-hide_banner', ...args], {
        windowsHide: true
      })
      let stderr = ''
      let timedOut = false
      const onAbort = () => child.kill()
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, ffmpegTimeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        job.controller.signal.removeEventListener('abort', onAbort)
      }
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-32768)
      })
      child.on('error', (error) => {
        cleanup()
        reject(new Error(`FFmpeg 无法启动：${error.message}`))
      })
      child.on('close', (code) => {
        cleanup()
        if (job.controller.signal.aborted) return reject(job.controller.signal.reason)
        if (timedOut) return reject(new Error('FFmpeg 处理超时，分片已保留供重试'))
        if (code !== 0 && !allowFailure)
          return reject(new Error(`FFmpeg 合成失败：${stderr.slice(-1500)}`))
        resolve({ ok: code === 0, stderr })
      })
    })
  }

  async function localPlaylist(job, track) {
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...track.segments.map((item) => item.duration)))}`
    ]
    let previousMap = null
    for (const segment of track.segments) {
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      if (segment.map && segment.map.file !== previousMap) {
        lines.push(`#EXT-X-MAP:URI="${segment.map.file}"`)
        previousMap = segment.map.file
      }
      lines.push(`#EXTINF:${segment.duration},`, segment.file)
    }
    lines.push('#EXT-X-ENDLIST')
    const path = join(job.partsDir, `${track.id}.local.m3u8`)
    await writeFile(path, lines.join('\n'), 'utf8')
    return path
  }

  async function merge(job) {
    const temp = join(job.partsDir, 'output.merging')
    let finalPath = job.finalPath
    rmSync(temp, { force: true })
    try {
      if (job.plan.needsMux) {
        const args = ['-y']
        for (const track of job.plan.tracks) {
          const playlist = await localPlaylist(job, track)
          args.push(
            '-protocol_whitelist',
            'file',
            '-allowed_extensions',
            'ALL',
            '-allowed_segment_extensions',
            'ALL',
            '-extension_picky',
            '0',
            '-i',
            playlist
          )
        }
        if (job.plan.tracks.length > 1) args.push('-map', '0:v:0', '-map', '1:a:0')
        else args.push('-map', '0:v?', '-map', '0:a?')
        args.push(
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-f',
          /\.m4a$/i.test(job.finalPath) ? 'ipod' : 'mp4',
          temp
        )
        await runFfmpeg(job, args)
      } else {
        const track = job.plan.tracks[0]
        const chunks = async function* () {
          if (track.segments[0].map) {
            job.controller.signal.throwIfAborted()
            yield await readFile(join(job.partsDir, track.segments[0].map.file))
          }
          for (const segment of track.segments) {
            job.controller.signal.throwIfAborted()
            yield await readFile(join(job.partsDir, segment.file))
          }
        }
        await pipeline(Readable.from(chunks()), createWriteStream(temp, { flags: 'wx' }), {
          signal: job.controller.signal
        })
      }
      job.controller.signal.throwIfAborted()
      let output = temp
      // 简单 TS 可以直接保存；有 FFmpeg 时无损转封装。源分片保留到最终发布成功。
      if (!job.plan.needsMux && ffmpegPath && existsSync(ffmpegPath)) {
        const probe = await runFfmpeg(job, ['-i', temp], true)
        if (!/Stream #\d+:\d+.*: (Video|Audio):/.test(probe.stderr)) {
          throw new Error('FFmpeg 无法识别下载内容中的音视频流')
        }
        const hasVideo = /Stream #\d+:\d+.*: Video:/.test(probe.stderr)
        if (!job.plan.tracks[0].maps.length) {
          const target = job.finalPath.replace(/\.[^.]+$/, hasVideo ? '.mp4' : '.m4a')
          if (existsSync(target)) throw new Error(`目标文件已存在：${target}`)
          output = join(job.partsDir, 'output.remuxing')
          await runFfmpeg(job, [
            '-y',
            '-i',
            temp,
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            '-f',
            hasVideo ? 'mp4' : 'ipod',
            output
          ])
          finalPath = target
        }
      }
      job.controller.signal.throwIfAborted()
      const size = statSync(output).size
      if (!size) throw new Error('合并结果为空')
      await link(output, finalPath)
      if (job.controller.signal.aborted) {
        rmSync(finalPath, { force: true })
        job.controller.signal.throwIfAborted()
      }
      job.completedBytes = size
      job.totalEstimate = size
      job.finalPath = finalPath
      job.status = 'complete'
      try {
        rmSync(job.partsDir, { recursive: true, force: true })
      } catch {
        log(`${job.gid} 输出已完成，临时目录清理失败`)
      }
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }

  function takeSegment(job) {
    const retry = job.retries.findIndex((item) => item.readyAt <= Date.now())
    if (retry >= 0) return job.retries.splice(retry, 1)[0].index
    while (job.cursor < job.plan.total && job.doneSet.has(job.cursor)) job.cursor++
    return job.cursor < job.plan.total ? job.cursor++ : -1
  }

  function throttleDown(job) {
    job.successStreak = Math.floor(job.successStreak / 2)
    const before = job.currentLimit
    job.currentLimit = Math.max(1, Math.floor(job.currentLimit / 2))
    log(`${job.gid} 降速 ${before}->${job.currentLimit}`)
  }

  function throttleRecover(job) {
    if (job.currentLimit >= job.baseLimit) return
    if (job.successStreak < job.currentLimit * 6) return
    job.currentLimit = Math.min(job.baseLimit, job.currentLimit * 2)
    job.successStreak = 0
    log(`${job.gid} 升速 -> ${job.currentLimit}`)
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
          // 升速后交回调度器补齐 worker，否则允许并发升了，实际仍只有旧 worker。
          if (job.activeWorkers < job.currentLimit) break
        } catch (error) {
          if (error.name === 'AbortError') throw error
          job.attempts[index] = (job.attempts[index] || 0) + 1
          log(`${job.gid} 分片${index} 第${job.attempts[index]}次失败: ${error.message}`)
          if (error.fatal || job.attempts[index] >= job.maxSegmentAttempts) {
            job.status = 'error'
            job.errorMessage = `分片 ${index + 1} 连续下载失败：${error.message}`
            log(`${job.gid} 任务失败: ${job.errorMessage}`)
            job.controller.abort()
            throw error
          }
          throttleDown(job)
          const delay = Math.min(
            errorBackoffMaxMs,
            errorBackoffBaseMs * 2 ** (job.attempts[index] - 1)
          )
          job.retries.push({
            index,
            readyAt: Date.now() + delay
          })
          await abortableSleep(delay, job.controller.signal)
        }
      }
    } finally {
      job.activeWorkers--
    }
  }

  async function downloadSegments(job) {
    const workers = new Set()
    try {
      while (job.status === 'active' && !job.controller.signal.aborted) {
        while (
          job.activeWorkers < job.currentLimit &&
          (job.retries.some((item) => item.readyAt <= Date.now()) || job.cursor < job.plan.total)
        ) {
          const promise = worker(job).finally(() => workers.delete(promise))
          workers.add(promise)
        }
        if (!workers.size) {
          if (!job.retries.length) break
          await abortableSleep(
            Math.max(1, Math.min(...job.retries.map((item) => item.readyAt)) - Date.now()),
            job.controller.signal
          )
          continue
        }
        // worker 退出（降速、升速或队列暂空）后，按最新上限补齐。
        await Promise.race(workers)
      }
    } finally {
      // 暂停/失败时等待所有 worker 退出，避免旧 worker 混入继续后的下载。
      await Promise.allSettled(workers)
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
      await downloadSegments(job)
      if (job.status !== 'active' || job.controller.signal.aborted) return
      if (job.done >= job.plan.total) {
        job.totalEstimate = Math.max(job.totalEstimate, job.completedBytes)
        log(`${job.gid} 全部分片完成，开始合并 ${job.finalPath}`)
        await merge(job)
        log(`${job.gid} 任务完成 -> ${job.finalPath}`)
      } else {
        // 有分片始终没下下来（不应发生），避免任务卡在 active
        job.status = 'error'
        job.errorMessage = '部分分片未能下载，请重试任务'
      }
    } catch (error) {
      if (!['paused', 'cancelled'].includes(job.status) && error.name !== 'AbortError') {
        job.status = 'error'
        // worker 内部已写过更具体的原因（如分片失败次数达上限）时不要覆盖
        job.errorMessage ||= error.message || '下载失败'
      }
    }
  }

  function snapshot(job, now) {
    // 错误状态等旧 worker 清理结束后再对外发布，避免立即重试与旧写盘竞争。
    const status = job.status === 'error' && job.running ? 'active' : job.status
    if (job.status === 'active') {
      const sample = job.lastSample
      if (sample.time) {
        const seconds = (now - sample.time) / 1000
        if (seconds > 0.25) {
          const instant = Math.max(0, (job.transferredBytes - sample.bytes) / seconds)
          job.speed = job.speed ? job.speed * 0.6 + instant * 0.4 : instant
          job.lastSample = { time: now, bytes: job.transferredBytes }
        }
      } else {
        job.lastSample = { time: now, bytes: job.transferredBytes }
      }
    }
    const total = Math.max(job.totalEstimate, job.completedBytes)
    return {
      status,
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
        transferredBytes: 0,
        storage: null,
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
      // 必须在翻转状态前等旧循环退出：旧 worker 靠 paused/中止信号离开，
      // 先改状态会让它误以为一切照旧，新 start 被无限推迟
      if (job.running) await job.runPromise.catch(() => {})
      job.controller = new AbortController()
      job.status = 'active'
      job.errorMessage = ''
      job.lastSample = { time: 0, bytes: 0 }
      // 手动继续 = 全新开始：丢弃毒队列和内存里的旧列表（重拉可拿到新签名地址），
      // 清零计数（completedBytes 会在扫描磁盘分片时重建，不清会翻倍）
      job.attempts = {}
      job.retries = []
      job.plan = null
      job.completedBytes = 0
      job.totalEstimate = 0
      job.currentLimit = 0
      job.successStreak = 0
      job.speed = 0
      job.transferredBytes = 0
      job.keys.clear()
      log(`${job.gid} 手动继续，重拉列表并重置调速`)
      void start(job)
    },
    async remove(gid) {
      const job = jobs.get(gid)
      if (!job) return
      job.status = job.status === 'complete' ? job.status : 'cancelled'
      job.controller.abort()
      if (job.runPromise) await job.runPromise.catch(() => {})
      jobs.delete(gid)
    },
    async destroy() {
      for (const job of jobs.values()) {
        if (job.status === 'active') job.status = 'cancelled'
        job.controller.abort()
      }
      await Promise.allSettled([...jobs.values()].map((job) => job.runPromise))
      jobs.clear()
    }
  }
}
