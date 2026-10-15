import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router/routes'
import App from './App.vue'
import '@fontsource/sora'
import '@fontsource/sora/600.css'
import '@fontsource/ibm-plex-mono'
import '@renderer/assets/css/tailwind.css'
import '@renderer/assets/css/global.css'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import piniaPersist from 'pinia-plugin-persist'

document.documentElement.classList.add('dark')

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPersist)
app.use(pinia)
app.use(router)
app.mount('#app')
