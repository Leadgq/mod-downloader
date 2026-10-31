import { app, Notification, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createAria2Driver } from './aria2-driver.mjs'
import { createTaskManager } from './task-manager.mjs'
import { createHlsDriver } from './hls/index.mjs'
import { createCompositeDriver } from './driver.mjs'
import { chromiumFetch } from './hls/chromium-fetch.mjs'

export function createAria2Service({ getWindow }) {
  const notifications = new Set()
  const binary = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const exe = app.isPackaged
    ? join(process.resourcesPath, 'bin', process.platform, binary)
    : join(app.getAppPath(), 'resources', 'bin', process.platform, binary)
  // ffmpeg 与 aria2c 同目录打包；缺失时简单 TS 可保存，分轨/Map 切换明确报错。
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegPath = app.isPackaged
    ? join(process.resourcesPath, 'bin', process.platform, ffmpegName)
    : join(app.getAppPath(), 'resources', 'bin', process.platform, ffmpegName)
  const manager = createTaskManager({
    driver: createCompositeDriver({
      aria2: createAria2Driver({ exe }),
      hls: createHlsDriver({
        fetchImpl: chromiumFetch,
        ffmpegPath: existsSync(ffmpegPath) ? ffmpegPath : '',
        debugLogPath: join(app.getPath('userData'), 'hls-debug.log')
      })
    }),
    historyPath: join(app.getPath('userData'), 'download-history.json'),
    onComplete: (task) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({
        title: '下载完成',
        body: task.filename || '文件已下载完成'
      })
      notifications.add(notification)
      notification.on('close', () => notifications.delete(notification))
      notification.on('click', () => {
        if (task.filePath && existsSync(task.filePath)) shell.showItemInFolder(task.filePath)
        else if (existsSync(task.dir)) void shell.openPath(task.dir)
      })
      notification.show()
    },
    onChange: (state) => {
      const window = getWindow()
      if (window && !window.isDestroyed()) window.webContents.send('download:changed', state)
    }
  })
  return {
    ...manager,
    async openTarget(id, kind, shell) {
      const task = manager.list().tasks.find((item) => item.id === id)
      if (!task) throw new Error('任务不存在')
      if (kind === 'file' && task.status !== 'complete') throw new Error('文件尚未下载完成')
      const target = kind === 'file' ? task.filePath || join(task.dir, task.filename) : task.dir
      if (!existsSync(target))
        throw new Error(kind === 'file' ? '文件不存在，可能已被移动或删除' : '保存目录不存在')
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    }
  }
}
