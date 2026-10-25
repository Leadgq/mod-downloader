import { defineStore } from 'pinia'

export const useConfigStore = defineStore('config', {
  state: () => ({
    url: '',
    query: [{ key: '', value: '' }],
    dir: '',
    filename: '',
    connections: 8,
    cookie: '',
    welcomed: false
  }),
  persist: {
    enabled: true,
    strategies: [
      {
        key: 'mod-downloader',
        storage: localStorage
      }
    ]
  }
})
