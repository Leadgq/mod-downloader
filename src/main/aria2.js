import { app } from 'electron'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'

const POLL_MS = 500

function resolveAria2Path() {
  const binary = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const folder = process.platform === 'win32' ? 'win32' : process.platform
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'bin', folder, binary) : null,
    join(app.getAppPath(), 'resources', 'bin', folder, binary),
    join(__dirname, '../../resources/bin', folder, binary)
  ].filter(Boolean)
  return candidates.find((item) => existsSync(item)) || candidates[candidates.length - 1]
}

function buildUri(url, query = []) {
  const parsed = new URL(url)
  for (const item of query) {
    const key = item?.key?.trim()
    if (!key) continue
    parsed.searchParams.set(key, item.value ?? '')
  }
  return parsed.toString()
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function mapStatus(raw) {
  if (!raw) return 'idle'
  if (raw === 'active' || raw === 'waiting' || raw === 'paused' || raw === 'complete' || raw === 'error') {
    return raw
  }
  if (raw === 'removed') return 'idle'
  return raw
}

export function createAria2Service({ getWindow }) {
  let child = null
  let secret = ''
  let port = 6800
  let gid = null
  let pollTimer = null
  let lastDir = ''
  let lastFilename = ''

  function emit(payload) {
    const win = getWindow?.()
    if (win && !win.isDestroyed()) {
      win.webContents.send('download:progress', payload)
    }
  }

  function snapshot(partial = {}) {
    return {
      status: 'idle',
      completedLength: 0,
      totalLength: 0,
      downloadSpeed: 0,
      connections: 0,
      errorMessage: '',
      percent: 0,
      filename: lastFilename,
      dir: lastDir,
      ...partial
    }
  }

  async function rpc(method, params = []) {
    const body = {
      jsonrpc: '2.0',
      id: `${Date.now()}`,
      method,
      params: [`token:${secret}`, ...params]
    }
    const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (data.error) {
      throw new Error(data.error.message || 'aria2 RPC 失败')
    }
    return data.result
  }

  async function waitUntilReady() {
    const deadline = Date.now() + 8000
    let lastError
    while (Date.now() < deadline) {
      try {
        await rpc('aria2.getVersion')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    throw lastError || new Error('aria2 RPC 启动超时')
  }

  async function startDaemon() {
    if (child) return
    const exe = resolveAria2Path()
    if (!existsSync(exe)) {
      throw new Error(`未找到 aria2 二进制：${exe}。请把官方 win-64 的 aria2c.exe 放到 resources/bin/win32/`)
    }

    secret = randomBytes(16).toString('hex')
    port = 6800

    child = spawn(
      exe,
      [
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        `--rpc-listen-port=${port}`,
        `--rpc-secret=${secret}`,
        '--quiet=true',
        '--continue=true'
      ],
      { stdio: 'ignore', windowsHide: true }
    )

    child.on('exit', () => {
      child = null
      gid = null
      stopPoll()
    })

    await waitUntilReady()
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function startPoll() {
    stopPoll()
    pollTimer = setInterval(async () => {
      if (!gid) return
      try {
        const status = await rpc('aria2.tellStatus', [
          gid,
          ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorMessage', 'files']
        ])
        const completedLength = toNumber(status.completedLength)
        const totalLength = toNumber(status.totalLength)
        const percent = totalLength > 0 ? Math.min(100, (completedLength / totalLength) * 100) : 0
        const filePath = status.files?.[0]?.path || ''
        lastFilename = filePath.split(/[/\\]/).pop() || lastFilename

        emit(
          snapshot({
            status: mapStatus(status.status),
            completedLength,
            totalLength,
            downloadSpeed: toNumber(status.downloadSpeed),
            connections: toNumber(status.connections),
            errorMessage: status.errorMessage || '',
            percent,
            filename: lastFilename
          })
        )

        if (status.status === 'complete' || status.status === 'error' || status.status === 'removed') {
          stopPoll()
        }
      } catch (error) {
        emit(snapshot({ status: 'error', errorMessage: error.message }))
        stopPoll()
      }
    }, POLL_MS)
  }

  async function start(payload) {
    await startDaemon()

    if (gid) {
      try {
        const current = await rpc('aria2.tellStatus', [gid, ['status']])
        if (current.status === 'active' || current.status === 'waiting') {
          throw new Error('已有任务在下载')
        }
        if (current.status === 'paused') {
          await rpc('aria2.unpause', [gid])
          startPoll()
          return { gid }
        }
        await rpc('aria2.remove', [gid]).catch(() => {})
      } catch (error) {
        if (error.message === '已有任务在下载') throw error
      }
      gid = null
    }

    const uri = buildUri(payload.url, payload.query)
    lastDir = payload.dir
    lastFilename = payload.filename || ''

    const connections = Math.min(16, Math.max(1, Number(payload.connections) || 8))
    const options = {
      dir: payload.dir,
      split: String(connections),
      'max-connection-per-server': String(connections),
      continue: 'true'
    }
    if (payload.filename) options.out = payload.filename
    if (payload.cookie?.trim()) {
      options.header = [`Cookie: ${payload.cookie.trim()}`]
    }

    gid = await rpc('aria2.addUri', [[uri], options])
    startPoll()
    emit(snapshot({ status: 'waiting' }))
    return { gid }
  }

  async function pause() {
    if (!gid) throw new Error('没有进行中的任务')
    await rpc('aria2.pause', [gid])
    emit(snapshot({ status: 'paused' }))
  }

  async function resume() {
    if (!gid) throw new Error('没有可继续的任务')
    await rpc('aria2.unpause', [gid])
    startPoll()
  }

  async function cancel() {
    if (gid) {
      await rpc('aria2.forceRemove', [gid]).catch(() => {})
    }
    gid = null
    stopPoll()
    emit(snapshot({ status: 'idle' }))
  }

  function destroy() {
    stopPoll()
    if (child) {
      child.kill()
      child = null
    }
    gid = null
  }

  return {
    start,
    pause,
    resume,
    cancel,
    destroy,
    getLastDir: () => lastDir
  }
}
