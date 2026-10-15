import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createAria2Driver } from './aria2-driver.mjs'
import { createTaskManager } from './task-manager.mjs'

export function createAria2Service({ getWindow }) {
  const binary = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  const exe = app.isPackaged
    ? join(process.resourcesPath, 'bin', process.platform, binary)
    : join(app.getAppPath(), 'resources', 'bin', process.platform, binary)
  const manager = createTaskManager({
    driver: createAria2Driver({ exe }),
    historyPath: join(app.getPath('userData'), 'download-history.json'),
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
