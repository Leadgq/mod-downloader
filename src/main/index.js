import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/deepblack-download.png?asset'
import { createMenu } from './menu'
import { createAria2Service } from './aria2'

// 产品显示名改为 Nox Downloader 后，锁定数据目录名仍为 mod-downloader，
// 老用户的下载历史（%APPDATA%\mod-downloader）才能延续
app.setName('mod-downloader')

let mainWindow = null
let aria2

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 880,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 下载进行中时确认退出；空闲时直接退出。quitting=true 表示已过确认环节
  mainWindow.on('close', (event) => {
    if (quitting || !aria2) return
    const busy = aria2.list().tasks.some((task) => ['active', 'waiting'].includes(task.status))
    if (!busy) return
    event.preventDefault()
    void dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Nox Downloader',
        message: '有任务正在下载',
        detail: '退出会中断当前下载。已完成的部分会保留，下次启动后可继续。',
        buttons: ['继续下载', '退出程序'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(({ response }) => {
        // 走 before-quit 的优雅关闭路径（停引擎、存进度）
        if (response === 1) app.quit()
      })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  createMenu({
    getDownloadDir: () => aria2.getLastDir()
  })
}

function registerIpc() {
  ipcMain.handle('download:list', () => aria2.list())
  ipcMain.handle('download:add', (_event, payload) => aria2.add(payload))
  ipcMain.handle('download:pause', (_event, id) => aria2.pause(id))
  ipcMain.handle('download:resume', (_event, id, payload) => aria2.resume(id, payload))
  ipcMain.handle('download:cancel', (_event, id) => aria2.cancel(id))
  ipcMain.handle('download:remove', (_event, id) => aria2.remove(id))
  ipcMain.handle('download:concurrency', (_event, value) => aria2.setConcurrency(value))
  ipcMain.handle('download:openTarget', (_event, id, kind) => aria2.openTarget(id, kind, shell))

  ipcMain.handle('download:chooseDir', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle('download:openDir', async (_event, dir) => {
    if (!dir) return
    await shell.openPath(dir)
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.moddownloader.app')
  aria2 = createAria2Service({ getWindow: () => mainWindow })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !aria2) return
  event.preventDefault()
  quitting = true
  aria2.destroy().finally(() => app.quit())
})
