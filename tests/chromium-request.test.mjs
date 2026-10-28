import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { createChromiumFetch } from '../src/main/chromium-request.mjs'

function mockNet(mode) {
  const request = new EventEmitter()
  request.setHeader = () => {}
  request.abort = () => {
    request.emit('error', new Error('transport aborted'))
    request.emit('close')
  }
  function respond() {
    const response = new EventEmitter()
    response.headers = {
      'Content-Length': mode === 'short' ? ['10'] : ['3'],
      'Content-Range': ['bytes 2-4/10']
    }
    response.statusCode = 206
    request.emit('response', response)
    response.emit('data', Buffer.from('abc'))
    response.emit('end')
    request.emit('close')
  }
  request.followRedirect = () => queueMicrotask(respond)
  request.end = () =>
    queueMicrotask(() => {
      if (mode === 'redirect')
        request.emit('redirect', 302, 'GET', 'https://example.test/final/index.m3u8', {})
      else if (mode === 'close') request.emit('close')
      else if (mode !== 'stall') respond()
    })
  return { request: () => request }
}

test('Chromium fetch 暴露最终 URL 和大小写不敏感的响应头', async () => {
  const controller = new AbortController()
  const response = await createChromiumFetch(mockNet('redirect'))('https://example.test/start', {
    signal: controller.signal
  })
  assert.equal(response.url, 'https://example.test/final/index.m3u8')
  assert.equal(response.headers.get('CONTENT-RANGE'), 'bytes 2-4/10')
  assert.equal(await response.text(), 'abc')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('Chromium fetch 拒绝截断响应及提前关闭', async () => {
  await assert.rejects(
    createChromiumFetch(mockNet('short'))('https://example.test/a'),
    /Content-Length/
  )
  await assert.rejects(
    createChromiumFetch(mockNet('close'))('https://example.test/a', { stallTimeoutMs: 5 }),
    /停滞/
  )
})

test('Chromium fetch 的停滞超时与总超时保留真实原因，并清理监听', async () => {
  for (const [options, pattern] of [
    [{ stallTimeoutMs: 5, totalTimeoutMs: 0 }, /停滞/],
    [{ stallTimeoutMs: 0, totalTimeoutMs: 5 }, /超时/]
  ]) {
    const controller = new AbortController()
    await assert.rejects(
      createChromiumFetch(mockNet('stall'))('https://example.test/a', {
        ...options,
        signal: controller.signal
      }),
      pattern
    )
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('Chromium fetch 支持已经中止及下载中中止的信号', async () => {
  const first = new AbortController()
  first.abort()
  await assert.rejects(
    createChromiumFetch(mockNet('stall'))('https://example.test/a', { signal: first.signal }),
    { name: 'AbortError' }
  )
  const second = new AbortController()
  const pending = createChromiumFetch(mockNet('stall'))('https://example.test/a', {
    signal: second.signal
  })
  second.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})
