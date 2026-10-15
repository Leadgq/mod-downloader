import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

function toPlain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const api = {
  start: (payload) => ipcRenderer.invoke('download:start', toPlain(payload)),
  pause: () => ipcRenderer.invoke('download:pause'),
  resume: () => ipcRenderer.invoke('download:resume'),
  cancel: () => ipcRenderer.invoke('download:cancel'),
  chooseDir: () => ipcRenderer.invoke('download:chooseDir'),
  openDir: (dir) => ipcRenderer.invoke('download:openDir', dir),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('download:progress', listener)
    return () => ipcRenderer.removeListener('download:progress', listener)
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
