// Browser polyfills for the node globals the client + web3 assume.
import { Buffer } from 'buffer'
;(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer
;(globalThis as any).global = globalThis
;(globalThis as any).process = (globalThis as any).process || { env: {}, version: '', browser: true }
