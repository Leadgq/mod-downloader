import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

export function createAria2Driver({ exe, requestTimeout = 3000, spawnProcess = spawn }) {
  let child = null
  let starting = null
  let secret = ''
  let port = 0
  let stopping = false
  let onFailure = () => {}

  async function rpc(method, params = []) {
    let data
    try {
      const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomBytes(8).toString('hex'),
          method,
          params: [`token:${secret}`, ...params]
        }),
        signal: AbortSignal.timeout(requestTimeout)
      })
      if (!response.ok) throw new Error(`下载引擎请求失败（${response.status}）`)
      data = await response.json()
    } catch (error) {
      error.engineUnavailable = true
      throw error
    }
    if (data.error) throw new Error(data.error.message || '下载引擎请求失败')
    return data.result
  }

  async function launch() {
    if (!existsSync(exe)) throw new Error(`未找到下载引擎：${exe}`)
    stopping = false
    secret = randomBytes(24).toString('hex')
    port = await availablePort()
    let failure = null
    let ready = false
    const process = spawnProcess(
      exe,
      [
        '--no-conf=true',
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        `--rpc-listen-port=${port}`,
        `--rpc-secret=${secret}`,
        '--quiet=true',
        '--continue=true',
        '--max-concurrent-downloads=5',
        '--max-connection-per-server=16',
        '--split=16',
        '--min-split-size=1M',
        '--auto-file-renaming=false',
        '--keep-unfinished-download-result=true'
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    child = process
    const failed = (error) => {
      failure = error
      if (child === process) child = null
      if (ready && !stopping) onFailure(error)
    }
    process.once('error', (error) => failed(new Error(`下载引擎无法启动：${error.message}`)))
    process.once('exit', (code) =>
      failed(new Error(`下载引擎已退出（${code ?? '未知'}），请重试任务`))
    )
    const deadline = Date.now() + 8000
    try {
      while (Date.now() < deadline) {
        if (failure) throw failure
        try {
          await rpc('aria2.getVersion')
          if (failure) throw failure
          ready = true
          return
        } catch (error) {
          if (failure) throw failure
          if (Date.now() >= deadline) throw error
          await delay(150)
        }
      }
      throw new Error('下载引擎启动超时，端口可能被占用')
    } catch (error) {
      process.kill()
      if (child === process) child = null
      throw new Error(`下载引擎启动失败：${error.message}`)
    }
  }

  async function ensure() {
    if (starting) return starting
    if (child) return
    starting = launch()
    try {
      await starting
    } catch (error) {
      throw new Error(`下载引擎无法启动：${error.message}`)
    } finally {
      starting = null
    }
  }

  return {
    setFailureHandler(handler) {
      onFailure = handler
    },
    ensure,
    async add(task, cookie) {
      const options = {
        dir: task.dir,
        continue: 'true',
        split: String(task.connectionsLimit),
        'max-connection-per-server': String(task.connectionsLimit),
        'min-split-size': '1M',
        'auto-file-renaming': 'false',
        'allow-overwrite': 'false'
      }
      if (task.filename) options.out = task.filename
      if (cookie) options.header = [`Cookie: ${cookie}`]
      return rpc('aria2.addUri', [[task.uri], options])
    },
    status(gid) {
      return rpc('aria2.tellStatus', [
        gid,
        [
          'status',
          'totalLength',
          'completedLength',
          'downloadSpeed',
          'connections',
          'errorMessage',
          'files'
        ]
      ])
    },
    async pause(gid) {
      await rpc('aria2.forcePause', [gid])
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await this.status(gid)
        if (['paused', 'complete', 'error'].includes(status.status)) return status
        await delay(100)
      }
      throw new Error('暂停尚未完成，请稍后再试')
    },
    resume: (gid) => rpc('aria2.unpause', [gid]),
    remove: (gid) => rpc('aria2.forceRemove', [gid]),
    async destroy() {
      stopping = true
      const process = child
      if (!process) return
      const exited = new Promise((resolve) => process.once('exit', resolve))
      await rpc('aria2.shutdown').catch(() => {})
      await Promise.race([exited, delay(2500)])
      if (child === process) {
        process.kill()
        await Promise.race([exited, delay(1000)])
        child = null
      }
    }
  }
}
