import { net } from 'electron'
import { createChromiumFetch } from './chromium-request.mjs'

export const chromiumFetch = createChromiumFetch(net)
