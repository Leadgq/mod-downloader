import { defineStore } from 'pinia'

export const useConfigStore = defineStore('config', {
  state: () => ({
    url: '',
    query: [{ key: '', value: '' }],
    dir: '',
    filename: '',
    connections: 8,
    welcomed: false
  }),
  persist: {
    enabled: true,
    strategies: [
      {
        key: 'mod-downloader',
        storage: localStorage,
        paths: ['url', 'query', 'dir', 'filename', 'connections', 'welcomed']
      }
    ]
  }
})
