import { Buffer } from 'buffer'
// @solana/web3.js and spl-token expect a Node Buffer global.
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
