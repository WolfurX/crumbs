// Client for crumb_store: byte blobs on Cookie Chain, streamed by a throwaway session key.
// Layout and rules in program/programs/crumb_store/src/lib.rs.
import { Buffer } from 'buffer'
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js'
import bs58 from 'bs58'
import idl from './idl/crumb_store.json'
import { buildIx } from '../game/codec'

export const STORE_PROGRAM = new PublicKey(idl.address)
export const HEADER = 96
/** Bytes per write transaction: 1232 minus ~220 of envelope, rounded down. */
export const CHUNK = 1000
/** Blobs up to this size are created, written and finalized in one transaction. */
export const INLINE_MAX = 700
/** Where finalized blobs are served from. Fixed to production so mints from the Pages mirror work too. */
export const GATEWAY = 'https://crumbs-cookie.vercel.app'
export const blobUrl = (blob: PublicKey | string) => `${GATEWAY}/s/${typeof blob === 'string' ? blob : blob.toBase58()}`

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const str = (s: string) => { const d = new TextEncoder().encode(s); return new Uint8Array([...u32(d.length), ...d]) }

export const initIx = (blob: PublicKey, authority: PublicKey, mime: string) => buildIx(idl, 'init', [str(mime)], { blob, authority })
export const writeIx = (blob: PublicKey, authority: PublicKey, offset: number, bytes: Uint8Array) => buildIx(idl, 'write', [u32(offset), u32(bytes.length), bytes], { blob, authority })
export const finalizeIx = (blob: PublicKey, authority: PublicKey, newAuthority: PublicKey) => buildIx(idl, 'finalize', [newAuthority.toBytes()], { blob, authority })
export const closeIx = (blob: PublicKey, authority: PublicKey, recipient: PublicKey) => buildIx(idl, 'close', [], { blob, authority, recipient })

export const blobRent = (connection: Connection, size: number) => connection.getMinimumBalanceForRentExemption(HEADER + size)
export const chunksOf = (size: number) => (size <= INLINE_MAX ? 0 : Math.ceil(size / CHUNK))
/** Transactions an upload takes: create (+inline), writes, finalize. */
export const txsOf = (size: number) => (size <= INLINE_MAX ? 1 : 2 + chunksOf(size))

/** Persistent upload state, so a drop resumes without re-sending chunks that landed. */
export interface UploadState {
  pubkey: string
  secret: string
  created: boolean
  chunks: number[]
  finalized: boolean
}

export function newUploadState(): UploadState {
  const kp = Keypair.generate()
  return { pubkey: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey), created: false, chunks: [], finalized: false }
}

export interface UploadOptions {
  connection: Connection
  uploader: Keypair
  bytes: Uint8Array
  mime: string
  /** Long-term authority once finalized: the creator's wallet. */
  owner: PublicKey
  state: UploadState
  save: () => void
  onProgress?: (done: number, total: number) => void
  concurrency?: number
}

/** Run up to n tasks at a time. */
export async function pool<T>(n: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      out[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return out
}

/** A blockhash shared by many transactions, refreshed every 20 s. */
export function blockhashCache(connection: Connection) {
  let cur: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null
  return async () => {
    if (!cur || Date.now() - cur.at > 20_000) cur = { ...(await connection.getLatestBlockhash('confirmed')), at: Date.now() }
    return cur
  }
}

export async function sendSigned(connection: Connection, tx: Transaction, bh: { blockhash: string; lastValidBlockHeight: number }): Promise<string> {
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
  const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
  if (res.value.err) throw new Error(`On-chain error: ${JSON.stringify(res.value.err)}`)
  return sig
}

async function withRetries<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await f()
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  throw last
}

/** Create, fill, finalize. Idempotent: reruns skip what the state says already landed. */
export async function uploadBlob(o: UploadOptions): Promise<PublicKey> {
  const { connection, uploader, bytes, mime, owner, state, save } = o
  const blobKp = Keypair.fromSecretKey(bs58.decode(state.secret))
  const blob = blobKp.publicKey
  const nextBlockhash = blockhashCache(connection)
  const total = chunksOf(bytes.length)
  const inline = bytes.length <= INLINE_MAX
  const progress = () => o.onProgress?.(state.chunks.length, total)

  if (!state.created) {
    const exists = await connection.getAccountInfo(blob, 'confirmed')
    if (!exists) {
      const lamports = await blobRent(connection, bytes.length)
      const ixs = [
        SystemProgram.createAccount({ fromPubkey: uploader.publicKey, newAccountPubkey: blob, lamports, space: HEADER + bytes.length, programId: STORE_PROGRAM }),
        initIx(blob, uploader.publicKey, mime),
      ]
      if (inline) ixs.push(writeIx(blob, uploader.publicKey, 0, bytes), finalizeIx(blob, uploader.publicKey, owner))
      await withRetries(async () => {
        const bh = await nextBlockhash()
        const tx = new Transaction({ feePayer: uploader.publicKey, recentBlockhash: bh.blockhash }).add(...ixs)
        tx.sign(uploader, blobKp)
        await sendSigned(connection, tx, bh)
      })
    }
    state.created = true
    if (inline) state.finalized = true
    save()
  }

  if (!inline) {
    const done = new Set(state.chunks)
    const pending = Array.from({ length: total }, (_, i) => i).filter((i) => !done.has(i))
    await pool(o.concurrency ?? 12, pending.map((i) => async () => {
      await withRetries(async () => {
        const bh = await nextBlockhash()
        const tx = new Transaction({ feePayer: uploader.publicKey, recentBlockhash: bh.blockhash }).add(writeIx(blob, uploader.publicKey, i * CHUNK, bytes.subarray(i * CHUNK, (i + 1) * CHUNK)))
        tx.sign(uploader)
        await sendSigned(connection, tx, bh)
      })
      state.chunks.push(i)
      save()
      progress()
    }))
    if (!state.finalized) {
      await withRetries(async () => {
        const bh = await nextBlockhash()
        const tx = new Transaction({ feePayer: uploader.publicKey, recentBlockhash: bh.blockhash }).add(finalizeIx(blob, uploader.publicKey, owner))
        tx.sign(uploader)
        await sendSigned(connection, tx, bh)
      })
      state.finalized = true
      save()
    }
  }
  return blob
}

/** Read a blob back from the chain (for verification scripts). */
export async function readBlob(connection: Connection, blob: PublicKey): Promise<{ mime: string; finalized: boolean; authority: PublicKey; bytes: Uint8Array } | null> {
  const info = await connection.getAccountInfo(blob, 'confirmed')
  if (!info || !info.owner.equals(STORE_PROGRAM)) return null
  const d = info.data
  if (Buffer.from(d.subarray(0, 8)).toString('latin1') !== 'crumblob') return null
  const len = new DataView(d.buffer, d.byteOffset).getUint32(40, true)
  return { mime: Buffer.from(d.subarray(46, 46 + d[45])).toString('latin1'), finalized: d[44] === 1, authority: new PublicKey(d.subarray(8, 40)), bytes: d.subarray(HEADER, HEADER + len) }
}
