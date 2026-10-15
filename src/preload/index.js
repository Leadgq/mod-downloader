import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

function toPlain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (error) {
    throw new Error(
      error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    )
  }
}

const api = {
  list: () => invoke('download:list'),
  add: (payload) => invoke('download:add', toPlain(payload)),
  pause: (id) => invoke('download:pause', id),
  resume: (id, payload) => invoke('download:resume', id, toPlain(payload)),
  cancel: (id) => invoke('download:cancel', id),
  remove: (id) => invoke('download:remove', id),
  setConcurrency: (value) => invoke('download:concurrency', value),
  openTarget: (id, kind) => invoke('download:openTarget', id, kind),
  chooseDir: () => invoke('download:chooseDir'),
  openDir: (dir) => invoke('download:openDir', dir),
  onChange: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('download:changed', listener)
    return () => ipcRenderer.removeListener('download:changed', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
