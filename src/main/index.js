import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createMenu } from './menu'
import { createAria2Service } from './aria2'

let mainWindow = null
const aria2 = createAria2Service({
  getWindow: () => mainWindow
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 880,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
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
  ipcMain.handle('download:start', async (_event, payload) => {
    return aria2.start(payload)
  })

  ipcMain.handle('download:pause', async () => {
    return aria2.pause()
  })

  ipcMain.handle('download:resume', async () => {
    return aria2.resume()
  })

  ipcMain.handle('download:cancel', async () => {
    return aria2.cancel()
  })

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

app.on('before-quit', () => {
  aria2.destroy()
})
