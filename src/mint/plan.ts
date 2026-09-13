// Costs and limits for a quick drop, computed before anything is signed.
import type { Connection } from '@solana/web3.js'
import { MINT_SIZE } from '@solana/spl-token'
import { blobUrl, chunksOf, HEADER, txsOf } from './blob'
import { GATEWAY } from './blob'
import { NAME_MAX, SYMBOL_MAX } from './tm'

export const MAX_PIECES = 1000
/** Room for " #1000" inside the 32-byte on-chain name. */
export const NAME_LIMIT = NAME_MAX - ' #1000'.length
export const DESCRIPTION_LIMIT = 300
export const ROYALTY_MAX_BPS = 5000
export const DEFAULT_ROYALTY_BPS = 500
/** Wallet prompts: pieces per signAllTransactions call. */
export const PIECES_PER_APPROVAL = 100
const FEE = 5000n
const BUFFER = 10_000_000n // 0.01 COOK of slack on the session key

export interface DropForm {
  name: string
  symbol: string
  description: string
  royaltyBps: number
}

export interface Rents {
  mint: bigint
  ata: bigint
  metadata: bigint
  edition: bigint
  /** Per byte-ish: rent for HEADER + n bytes is computed from these two samples. */
  blobBase: bigint
  blobPerByte: bigint
}

let rentsCache: Promise<Rents> | null = null
export function fetchRents(connection: Connection): Promise<Rents> {
  if (!rentsCache) {
    rentsCache = (async () => {
      const [mint, ata, metadata, edition, b0, b1] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(MINT_SIZE),
        connection.getMinimumBalanceForRentExemption(165),
        connection.getMinimumBalanceForRentExemption(679),
        connection.getMinimumBalanceForRentExemption(282),
        connection.getMinimumBalanceForRentExemption(HEADER),
        connection.getMinimumBalanceForRentExemption(HEADER + 100_000),
      ])
      return { mint: BigInt(mint), ata: BigInt(ata), metadata: BigInt(metadata), edition: BigInt(edition), blobBase: BigInt(b0), blobPerByte: (BigInt(b1) - BigInt(b0)) / 100_000n }
    })().catch((e) => {
      rentsCache = null
      throw e
    })
  }
  return rentsCache
}

export const blobRentOf = (r: Rents, size: number) => r.blobBase + r.blobPerByte * BigInt(size)

export function deriveSymbol(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const raw = (words.length >= 2 ? words.map((w) => w[0]).join('') : words[0] ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase()
  const s = raw.slice(0, SYMBOL_MAX)
  return s.length >= 2 ? s : (s + 'NFT').slice(0, 3)
}

export const pieceName = (name: string, n: number) => `${name.trim()} #${n}`

export function pieceJson(form: DropForm, n: number | null, imageBlob: string, mime: string): string {
  const image = blobUrl(imageBlob)
  return JSON.stringify({
    name: n === null ? form.name.trim() : pieceName(form.name, n),
    symbol: form.symbol,
    description: form.description.trim(),
    image,
    external_url: `${GATEWAY}/`,
    attributes: [],
    properties: { files: [{ uri: image, type: mime }], category: 'image' },
  })
}

export interface Estimate {
  /** Rent of the picture blob. */
  image: bigint
  /** Rent of all metadata JSON blobs, collection included. */
  labels: bigint
  /** Mint, token account, metadata and edition rent for every piece and the collection. */
  pieces: bigint
  fees: bigint
  total: bigint
  /** What the session key is funded with: blobs plus their fees plus slack. */
  session: bigint
  /** Transactions the session key sends. */
  storeTxs: number
  /** Transactions the wallet signs: collection plus one per piece. */
  mintTxs: number
  approvals: number
}

export function estimate(r: Rents, form: DropForm, imageSize: number, mime: string, count: number): Estimate {
  const labelSize = new TextEncoder().encode(pieceJson(form, MAX_PIECES, '1'.repeat(44), mime)).length
  const image = blobRentOf(r, imageSize)
  const labels = blobRentOf(r, labelSize) * BigInt(count + 1)
  const storeTxs = txsOf(imageSize) + (count + 1) * txsOf(labelSize) + 1
  const mintTxs = count + 1
  const per = r.mint + r.ata + r.metadata + r.edition
  const pieces = per * BigInt(count + 1)
  const fees = FEE * BigInt(storeTxs + mintTxs)
  const session = image + labels + FEE * BigInt(storeTxs) + BUFFER
  return { image, labels, pieces, fees, total: session + pieces + FEE * BigInt(mintTxs), session, storeTxs, mintTxs, approvals: 1 + Math.ceil(mintTxs / PIECES_PER_APPROVAL) }
}

export const chunkCount = chunksOf
export { NAME_MAX, SYMBOL_MAX }
