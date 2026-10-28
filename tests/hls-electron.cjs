const { app } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  let driver
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url === '/start.m3u8') {
      response.writeHead(302, { Location: '/nested/index.m3u8?sign=ok' })
      return response.end()
    }
    if (request.url.startsWith('/nested/index.m3u8')) {
      return response.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-BYTERANGE:3@2\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST'
      )
    }
    if (request.url === '/nested/a.ts?sign=ok') {
      assert.equal(request.headers.range, 'bytes=2-4')
      response.writeHead(206, { 'Content-Range': 'bytes 2-4/6', 'Content-Length': '3' })
      return response.end('cde')
    }
    response.writeHead(404)
    response.end()
  })
  try {
    const { chromiumFetch } = await import('../src/main/chromium-fetch.mjs')
    const { createHlsDriver } = await import('../src/main/hls.mjs')
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const response = await chromiumFetch(`${base}/start.m3u8`)
    assert.equal(response.url, `${base}/nested/index.m3u8?sign=ok`)
    driver = createHlsDriver({ fetchImpl: chromiumFetch, maxRetries: 0, maxSegmentAttempts: 1 })
    const dir = mkdtempSync(join(tmpdir(), 'hls-electron-'))
    const gid = await driver.add({
      uri: `${base}/start.m3u8`,
      filename: 'video.ts',
      dir,
      connectionsLimit: 2
    })
    for (let i = 0; i < 500 && driver.status(gid).status === 'active'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const status = driver.status(gid)
    assert.equal(status.status, 'complete', status.errorMessage)
    assert.equal(readFileSync(status.files[0].path, 'utf8'), 'cde')
    assert.ok(requests.includes('/nested/a.ts?sign=ok'))
    console.log(
      'Electron Chromium HLS: redirect, response headers, signed relative URL and Range passed'
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await driver?.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    app.exit(process.exitCode || 0)
  }
})
