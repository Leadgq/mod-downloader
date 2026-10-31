// Run with Electron after building. All task data and files use an isolated temp directory.
const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')

const dir = mkdtempSync(join(tmpdir(), 'mod-ui-'))
const output = join(__dirname, '../out/qa')
mkdirSync(output, { recursive: true })
app.setPath('userData', dir)
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  let window
  let manager
  try {
    const { createTaskManager } = await import('../src/main/task-manager.mjs')
    const now = Date.now()
    const makeTask = (id, filename, status) => ({
      id,
      filename,
      status,
      url: `https://example.com/${filename}`,
      uri: `https://example.com/${filename}`,
      query: [],
      dir,
      connectionsLimit: 8,
      hadCookie: false,
      createdAt: now + Number(id),
      queuedAt: now + Number(id),
      updatedAt: now,
      completedAt: status === 'complete' ? now : null,
      completedLength: 680 * 1024 * 1024,
      totalLength: 1024 ** 3,
      percent: status === 'complete' ? 100 : 68,
      downloadSpeed: 0,
      connections: 0,
      errorMessage: '',
      filePath: join(dir, filename)
    })
    const historyPath = join(dir, 'history.json')
    writeFileSync(
      historyPath,
      JSON.stringify({
        version: 1,
        maxConcurrent: 2,
        tasks: [
          makeTask('1', '高清材质包 HD Textures.zip', 'paused'),
          makeTask('2', '游戏资源补丁 v2.1.zip', 'paused'),
          makeTask('3', '角色外观扩展包.zip', 'paused'),
          makeTask('4', '地图扩展 · Northern Lands.zip', 'complete'),
          makeTask('5', '旧版本资源.zip', 'cancelled')
        ]
      })
    )
    const records = new Map()
    const driver = {
      setFailureHandler() {},
      async ensure() {},
      async add(task) {
        records.set(task.id, task)
        return task.id
      },
      async status(id) {
        const task = records.get(id)
        return {
          status: 'active',
          completedLength: String(task.completedLength),
          totalLength: String(task.totalLength),
          downloadSpeed: String(12 * 1024 * 1024),
          connections: '8',
          files: [{ path: join(dir, task.filename) }]
        }
      },
      async pause(id) {
        return { ...(await this.status(id)), status: 'paused' }
      },
      async resume() {},
      async remove(id) {
        records.delete(id)
      },
      async destroy() {}
    }
    manager = createTaskManager({
      driver,
      historyPath,
      onChange: (state) => window?.webContents.send('download:changed', state)
    })
    ipcMain.handle('download:list', () => manager.list())
    for (const method of ['add', 'pause', 'resume', 'cancel', 'remove'])
      ipcMain.handle(`download:${method}`, (_, ...args) => manager[method](...args))
    ipcMain.handle('download:concurrency', (_, value) => manager.setConcurrency(value))
    ipcMain.handle('download:chooseDir', () => dir)
    ipcMain.handle('download:openTarget', () => {
      throw new Error('文件不存在，可能已被移动或删除')
    })
    await manager.resume('1')
    await manager.resume('2')
    await manager.resume('3')
    window = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      webPreferences: {
        preload: join(__dirname, '../out/preload/index.js'),
        sandbox: false,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    const failures = []
    window.webContents.on('console-message', (_, level, message) => {
      if (level >= 3) failures.push(message)
    })
    await window.loadFile(join(__dirname, '../out/renderer/index.html'))
    const run = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await run(`Boolean(${code})`)) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`UI check timed out: ${code}`)
    }
    const click = (label) =>
      run(
        `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw Error('Button missing'); button.click() })()`
      )
    // 首次启动落在欢迎页，点击开始使用后进入主界面
    await waitFor("document.body.textContent.includes('开始使用')")
    await run("document.querySelector('.start-button').click()")
    await waitFor("document.body.textContent.includes('Nox Downloader')")
    await waitFor("document.querySelectorAll('.task-card').length === 5")
    await run('document.fonts.ready.then(() => true)')
    writeFileSync(join(output, 'downloads.png'), (await window.webContents.capturePage()).toPNG())
    await run("document.querySelector('.filter-button:nth-child(3)').click()")
    await waitFor(
      "document.querySelectorAll('.task-card').length === 1 && document.querySelector('.task-complete')"
    )
    await click('打开文件')
    await waitFor("document.body.textContent.includes('文件不存在')")
    await run("document.querySelector('.el-message__closeBtn')?.click()")
    // Clear the expected error toast before taking the dialog screenshot.
    await waitFor("!document.querySelector('.el-message')")
    await run("document.querySelector('.filter-button').click()")
    await click('新建下载')
    await waitFor("document.querySelector('#task-url')")
    await new Promise((resolve) => setTimeout(resolve, 400))
    writeFileSync(
      join(output, 'new-download.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await click('添加下载')
    await waitFor("document.querySelector('.form-error')?.textContent.includes('请填写')")
    await run(
      "(() => { const input = document.querySelector('#task-url'); input.value = 'https://example.com/new.zip'; input.dispatchEvent(new Event('input', { bubbles: true })) })()"
    )
    await click('浏览')
    await waitFor(`document.querySelector('#task-dir').value === ${JSON.stringify(dir)}`)
    await run(
      "(() => { const input = document.querySelector('#task-cookie'); input.value = 'private=test-cookie'; input.dispatchEvent(new Event('input', { bubbles: true })) })()"
    )
    await click('添加下载')
    await waitFor(
      "document.querySelectorAll('.task-card').length === 6 && !document.querySelector('.el-overlay-dialog')?.offsetHeight"
    )
    assert.equal((await run("localStorage.getItem('mod-downloader')")).includes('test-cookie'), false)
    await run(
      "(() => { const input = document.querySelector('.search input'); input.value = 'new.zip'; input.dispatchEvent(new Event('input', { bubbles: true })) })()"
    )
    await waitFor("document.querySelectorAll('.task-card').length === 1")
    await click('取消')
    await waitFor("document.querySelector('.task-cancelled')")
    assert.equal(manager.list().tasks.at(-1).status, 'cancelled')
    const completedState = manager.list()
    const finishedTask = completedState.tasks.find((task) => task.status === 'active')
    finishedTask.status = 'complete'
    completedState.revision++
    window.webContents.send('download:changed', completedState)
    await waitFor(
      `document.querySelector('.el-notification')?.textContent.includes(${JSON.stringify(finishedTask.filename)})`
    )
    window.webContents.send('download:changed', completedState)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await run("document.querySelectorAll('.el-notification').length"), 1)
    assert.deepEqual(failures, [])
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true }))
    console.log(
      'UI smoke passed: list, filters, missing file feedback, dialog validation, adding, searching and cancelling. Screenshots: out/qa/'
    )
    await manager.destroy()
    window.destroy()
    app.exit(0)
  } catch (error) {
    if (window && !window.isDestroyed()) {
      const diagnostics = await window.webContents.executeJavaScript(
        `JSON.stringify({ cards: document.querySelectorAll('.task-card').length, error: document.querySelector('.form-error')?.textContent, url: document.querySelector('#task-url')?.value, dir: document.querySelector('#task-dir')?.value, dialog: document.querySelector('.el-overlay-dialog')?.offsetHeight, text: document.body.textContent })`
      )
      writeFileSync(join(output, 'diagnostics.json'), diagnostics)
      writeFileSync(join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG())
    }
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify({ passed: false, error: error.stack })
    )
    console.error(error)
    if (manager) await manager.destroy()
    if (window) window.destroy()
    app.exit(1)
  }
})
