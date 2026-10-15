import { defineStore } from 'pinia'

export const useConfigStore = defineStore('config', {
  state: () => {
    return {}
  },
  actions: {},
  persist: {
    enabled: true,
    strategies: []
  }
})
