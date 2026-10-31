import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const unfinished = (task) => !['complete', 'cancelled'].includes(task.status)
const number = (value) => Math.max(0, Number(value) || 0)

function parameters(payload) {
  let url
  try {
    url = new URL(String(payload.url || '').trim())
  } catch {
    throw new Error('下载地址不是有效的 URL')
  }
  if (!['http:', 'https:', 'ftp:'].includes(url.protocol))
    throw new Error('仅支持 HTTP、HTTPS 或 FTP 下载地址')
  const query = (Array.isArray(payload.query) ? payload.query : []).map(({ key, value }) => ({
    key: String(key || '').trim(),
    value: String(value || '')
  }))
  for (const item of query) if (item.key) url.searchParams.set(item.key, item.value)
  const dir = String(payload.dir || '').trim()
  if (!dir || !isAbsolute(dir)) throw new Error('请选择有效的绝对保存路径')
  const filename = String(payload.filename || '').trim()
  if (
    filename &&
    (/[<>:"/\\|?*]/.test(filename) ||
      [...filename].some((char) => char.charCodeAt(0) < 32) ||
      /[. ]$/.test(filename) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename))
  )
    throw new Error('文件名包含无效字符或保留名称')
  const cookie = String(payload.cookie || '').trim()
  if (/[\r\n]/.test(cookie)) throw new Error('Cookie 不能包含换行')
  return {
    url: String(payload.url).trim(),
    uri: url.toString(),
    query,
    dir,
    filename,
    connectionsLimit: Math.min(16, Math.max(1, Math.floor(Number(payload.connections) || 8))),
    cookie
  }
}

export function createTaskManager({
  driver,
  historyPath,
  onChange = () => {},
  onComplete = () => {},
  pollMs = 500,
  saveMs = 2000
}) {
  let tasks = []
  let maxConcurrent = 2
  let revision = 0
  let warning = ''
  let fault = false
  let closing = false
  let persistBlocked = false
  let saveTimer = null
  let chain = Promise.resolve()
  const gids = new Map()
  const cookies = new Map()
  const serialize = (fn) => {
    const next = chain.then(fn)
    chain = next.catch(() => {})
    return next
  }

  try {
    if (existsSync(historyPath)) {
      const saved = JSON.parse(readFileSync(historyPath, 'utf8'))
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('记录格式不正确')
      for (const task of saved.tasks) {
        if (
          typeof task.id !== 'string' ||
          !Array.isArray(task.query) ||
          !['active', 'waiting', 'paused', 'error', 'complete', 'cancelled'].includes(task.status)
        )
          throw new Error('任务记录不完整')
        parameters({ ...task, connections: task.connectionsLimit })
      }
      maxConcurrent = Math.min(5, Math.max(1, Math.floor(Number(saved.maxConcurrent) || 2)))
      tasks = saved.tasks.map((task) => ({
        ...task,
        status: unfinished(task) ? 'paused' : task.status,
        downloadSpeed: 0,
        connections: 0,
        needsCookie: Boolean(task.hadCookie)
      }))
    }
  } catch (error) {
    if (existsSync(historyPath)) {
      try {
        renameSync(historyPath, `${historyPath}.corrupt-${Date.now()}`)
      } catch {
        persistBlocked = true
      }
    }
    warning = `历史记录读取失败，原文件已尝试保留：${error.message}`
  }

  function list() {
    return structuredClone({ tasks, maxConcurrent, revision, warning })
  }
  function emit() {
    revision++
    onChange(list())
  }
  function persist() {
    clearTimeout(saveTimer)
    saveTimer = null
    if (persistBlocked) return
    try {
      mkdirSync(dirname(historyPath), { recursive: true })
      writeFileSync(
        `${historyPath}.tmp`,
        JSON.stringify({ version: 1, maxConcurrent, tasks }),
        'utf8'
      )
      renameSync(`${historyPath}.tmp`, historyPath)
      if (warning.startsWith('下载记录未能保存')) warning = ''
    } catch (error) {
      warning = `下载记录未能保存：${error.message}`
    }
  }
  function changed(immediate = true) {
    if (immediate) persist()
    else if (!saveTimer)
      saveTimer = setTimeout(() => {
        persist()
        emit()
      }, saveMs)
    emit()
  }
  function find(id) {
    const task = tasks.find((item) => item.id === id)
    if (!task) throw new Error('任务不存在')
    return task
  }
  function update(task, status) {
    const wasComplete = task.status === 'complete'
    task.completedLength = number(status.completedLength)
    task.totalLength = number(status.totalLength)
    task.downloadSpeed = status.status === 'active' ? number(status.downloadSpeed) : 0
    task.connections = status.status === 'active' ? number(status.connections) : 0
    const path = status.files?.[0]?.path
    if (path) {
      task.filePath = path
      task.filename = basename(path)
    }
    task.percent = task.totalLength
      ? Math.min(100, (task.completedLength / task.totalLength) * 100)
      : 0
    if (['complete', 'error', 'paused'].includes(status.status)) {
      task.status = status.status
      if (status.status !== 'paused') gids.delete(task.id)
      if (status.status === 'complete') {
        task.percent = 100
        task.completedAt = Date.now()
      }
      task.errorMessage = status.errorMessage || ''
      task.updatedAt = Date.now()
      if (status.status === 'complete' && !wasComplete) {
        try {
          onComplete(task)
        } catch {
          // 通知失败不能让已完成的下载变成引擎错误。
        }
      }
    }
  }
  function failEngine(error) {
    fault = true
    for (const task of tasks) {
      if (['active', 'waiting'].includes(task.status)) {
        task.status = 'error'
        task.errorMessage = error.message || '下载引擎连接失败，请重试'
        task.downloadSpeed = 0
        task.connections = 0
        task.updatedAt = Date.now()
      }
    }
    gids.clear()
    changed()
  }
  driver.setFailureHandler((error) => {
    if (!closing) void serialize(() => failEngine(error))
  })

  async function schedule() {
    if (fault || closing) return
    let active = tasks.filter((task) => task.status === 'active').length
    for (const task of tasks
      .filter((item) => item.status === 'waiting')
      .sort((a, b) => a.queuedAt - b.queuedAt)) {
      if (active >= maxConcurrent) break
      try {
        await driver.ensure()
      } catch (error) {
        failEngine(error)
        return
      }
      try {
        if (gids.has(task.id)) await driver.resume(gids.get(task.id))
        else gids.set(task.id, await driver.add(task, cookies.get(task.id)))
        task.status = 'active'
        task.errorMessage = ''
        active++
      } catch (error) {
        if (error.engineUnavailable) {
          await driver.destroy()
          failEngine(new Error(`下载引擎连接失败：${error.message}`))
          return
        }
        task.status = 'error'
        task.errorMessage = error.message
        gids.delete(task.id)
      }
      task.updatedAt = Date.now()
      changed()
    }
  }

  async function poll() {
    if (closing || fault) return
    let dirty = false
    let terminal = false
    for (const task of tasks.filter((item) => item.status === 'active')) {
      try {
        const status = await driver.status(gids.get(task.id))
        update(task, status)
        dirty = true
        if (task.status !== 'active') terminal = true
      } catch (error) {
        await driver.destroy()
        failEngine(new Error(`下载引擎连接失败：${error.message}`))
        return
      }
    }
    if (dirty) changed(terminal)
    await schedule()
  }
  // Recursive timer prevents overlapping polls and an ever-growing operation queue.
  let timer
  async function tick() {
    try {
      await serialize(poll)
    } finally {
      if (!closing) timer = setTimeout(tick, pollMs)
    }
  }
  timer = setTimeout(tick, pollMs)

  function checkTarget(params, exceptId) {
    const targetName = (task) => {
      if (task.filename) return task.filename
      try {
        return decodeURIComponent(new URL(task.uri).pathname.split('/').pop())
      } catch {
        return ''
      }
    }
    const name = targetName(params)
    if (!name) return
    const target = resolve(params.dir, name).toLowerCase()
    if (
      tasks.some(
        (task) =>
          task.id !== exceptId &&
          unfinished(task) &&
          targetName(task) &&
          resolve(task.dir, targetName(task)).toLowerCase() === target
      )
    ) {
      throw new Error('已有未完成任务使用此保存路径，请更换文件名或先取消原任务')
    }
  }

  return {
    list,
    add: (payload) =>
      serialize(async () => {
        const { cookie, ...params } = parameters(payload)
        checkTarget(params)
        const now = Date.now()
        const task = {
          ...params,
          id: randomUUID(),
          status: 'waiting',
          createdAt: now,
          queuedAt: now,
          updatedAt: now,
          completedAt: null,
          completedLength: 0,
          totalLength: 0,
          downloadSpeed: 0,
          connections: 0,
          percent: 0,
          filePath: '',
          errorMessage: '',
          hadCookie: Boolean(cookie),
          needsCookie: false
        }
        tasks.push(task)
        if (cookie) cookies.set(task.id, cookie)
        changed()
        fault = false
        await schedule()
        return list()
      }),
    pause: (id) =>
      serialize(async () => {
        const task = find(id)
        if (!['active', 'waiting'].includes(task.status)) return list()
        if (task.status === 'active') update(task, await driver.pause(gids.get(id)))
        if (!['complete', 'error'].includes(task.status)) task.status = 'paused'
        task.downloadSpeed = 0
        task.connections = 0
        task.updatedAt = Date.now()
        changed()
        await schedule()
        return list()
      }),
    resume: (id, payload) =>
      serialize(async () => {
        const task = find(id)
        if (!['paused', 'error'].includes(task.status)) return list()
        if (payload) {
          const { cookie, ...params } = parameters(payload)
          if (task.needsCookie && !cookie) throw new Error('此任务需要重新填写 Cookie')
          checkTarget(params, id)
          if (params.dir !== task.dir || (params.filename && params.filename !== task.filename))
            throw new Error('继续任务时请保留原目录和文件名')
          if (gids.has(id)) {
            await driver.remove(gids.get(id))
            gids.delete(id)
          }
          Object.assign(task, params, {
            filename: task.filename || params.filename,
            hadCookie: Boolean(cookie),
            needsCookie: false
          })
          if (cookie) cookies.set(id, cookie)
          else cookies.delete(id)
        }
        if (task.needsCookie) throw new Error('此任务需要重新填写 Cookie')
        checkTarget(task, id)
        task.status = 'waiting'
        task.errorMessage = ''
        task.queuedAt = Date.now()
        task.updatedAt = Date.now()
        fault = false
        changed()
        await schedule()
        return list()
      }),
    cancel: (id) =>
      serialize(async () => {
        const task = find(id)
        if (!unfinished(task)) return list()
        if (gids.has(id)) {
          await driver.remove(gids.get(id))
          gids.delete(id)
        }
        Object.assign(task, {
          status: 'cancelled',
          downloadSpeed: 0,
          connections: 0,
          updatedAt: Date.now()
        })
        cookies.delete(id)
        changed()
        await schedule()
        return list()
      }),
    remove: (id) =>
      serialize(() => {
        const task = find(id)
        if (unfinished(task)) throw new Error('请先取消下载，再移除记录')
        tasks = tasks.filter((item) => item.id !== id)
        cookies.delete(id)
        changed()
        return list()
      }),
    setConcurrency: (value) =>
      serialize(async () => {
        if (!Number.isInteger(value) || value < 1 || value > 5)
          throw new Error('同时下载数量应为 1～5')
        maxConcurrent = value
        changed()
        await schedule()
        return list()
      }),
    getLastDir: () => tasks.at(-1)?.dir || '',
    async destroy() {
      closing = true
      clearTimeout(timer)
      await serialize(async () => {
        await driver.destroy()
        persist()
      })
    }
  }
}
