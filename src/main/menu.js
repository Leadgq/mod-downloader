const { app, Menu, shell } = require('electron')

const isMac = process.platform === 'darwin'

export const createMenu = (wind) => {
  const config = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { role: 'services' },
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
      label: '查看',
      submenu: [
        {
          label: '地址'
        },
        isMac ? { role: 'close' } : { role: 'quit' },
        {
          label: '发送事件',
          click: () => {
            wind.webContents.send('menuEvent', 'hello electron')
          }
        }
      ]
    },
    {
      label: '操作',
      submenu: [
        {
          label: '打开网站',
          click: () => {
            shell.openExternal('http://www.baidu.com')
          }
        },
        { type: 'separator' },
        {
          label: '测试'
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(config))
}
