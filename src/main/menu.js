import { app, Menu, shell } from 'electron'

const isMac = process.platform === 'darwin'

export const createMenu = ({ getDownloadDir } = {}) => {
  const config = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开下载目录',
          click: async () => {
            const dir = getDownloadDir?.()
            if (dir) {
              await shell.openPath(dir)
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(config))
}
