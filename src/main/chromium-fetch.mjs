import { net } from 'electron'

// 用 Electron net 模块（Chromium 网络栈）实现 fetch 兼容接口。
// 带 TLS 指纹识别的防护站（如月盾）只放行浏览器特征的网络栈，
// Node 自带 fetch 的握手特征会被识别并返回验证页。
// 仅支持本下载器用到的能力：自定义请求头、跟随重定向、整体缓冲响应体、可中止。
export function chromiumFetch(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request(String(url))
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    const chunks = []
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
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
    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        if (settled) return
        settled = true
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
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    request.end()
  })
}
