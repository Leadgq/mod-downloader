import { net } from 'electron'

// 用 Electron net 模块（Chromium 网络栈）实现 fetch 兼容接口。
// 带 TLS 指纹识别的防护站（如月盾）只放行浏览器特征的网络栈，
// Node 自带 fetch 的握手特征会被识别并返回验证页。
// 仅支持本下载器用到的能力：自定义请求头、跟随重定向、整体缓冲响应体、可中止。
export function chromiumFetch(
  url,
  { headers = {}, signal, stallTimeoutMs = 20000, totalTimeoutMs = 90000 } = {}
) {
  return new Promise((resolve, reject) => {
    const request = net.request(String(url))
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    const chunks = []
    let settled = false
    const settleAll = () => {
      clearTimeout(stallTimer)
      clearTimeout(totalTimer)
    }
    // 停滞看门狗：拥塞线路会让 TCP 半死连接既不来数据也不报错，
    // fetch 永远悬着，下载器就"醒不过来"。超时就主动掐断交给重试。
    let stallTimer = null
    const armStall = () => {
      if (!stallTimeoutMs) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        request.abort()
        fail(new Error(`连接停滞（${Math.round(stallTimeoutMs / 1000)} 秒无数据），已断开待重试`))
      }, stallTimeoutMs)
    }
    // 总时长兜底：个别服务器对被限速的连接"滴流"——每几十秒滴几字节，
    // 停滞看门狗永远不触发，但速度约等于零。超过总上限直接掐断。
    const totalTimer = totalTimeoutMs
      ? setTimeout(() => {
          request.abort()
          fail(new Error(`请求超时（${Math.round(totalTimeoutMs / 1000)} 秒），已断开待重试`))
        }, totalTimeoutMs)
      : null
    const onAbort = () => {
      if (settled) return
      settled = true
      settleAll()
      request.abort()
      const error = new Error('已中止')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      settleAll()
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(error)
    }
    armStall()
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        armStall()
        chunks.push(Buffer.from(chunk))
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        settleAll()
        if (signal) signal.removeEventListener('abort', onAbort)
        const body = Buffer.concat(chunks)
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          url: String(url),
          arrayBuffer: async () =>
            body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          text: async () => body.toString('utf8')
        })
      })
      // 传输层错误（如 ERR_CONTENT_LENGTH_MISMATCH）从 response 上抛出；
      // 不挂处理器会让 error 事件炸穿主进程
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('连接中断，数据不完整')))
    })
    request.on('error', fail)
    request.end()
  })
}
