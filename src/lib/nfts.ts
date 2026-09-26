import { PublicKey, type Connection } from '@solana/web3.js'
import { readNftMetas } from './collection'
import { shortAddr } from './format'
import type { OwnedAccount } from './revoke'

/** One NFT in the wallet, with the token account that holds it (not always the associated one). */
export interface Piece {
  mint: string
  name: string
  account: string
  programId: PublicKey
}

/** The pieces of one verified collection that the wallet holds. */
export interface NftGroup {
  /** The collection mint. */
  collection: string
  name: string
  symbol: string
  /** In name order (Name #1, #2, …), so a drop goes out in sequence. */
  pieces: Piece[]
}

export interface WalletNfts {
  /** Largest collection first. */
  groups: NftGroup[]
  /** Every mint with Token Metadata the wallet holds one of: pieces, collection parents, single NFTs. Not tokens. */
  mints: Set<string>
}

/** Standard NFTs and editions, which a plain token transfer can move; programmable NFTs need the metadata program's own transfer. */
const sendable = (standard: number | null) => standard === null || standard === 0 || standard === 3

const numberOf = (name: string) => {
  const m = /#(\d+)\s*$/.exec(name)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}
const byName = (a: Piece, b: Piece) => numberOf(a.name) - numberOf(b.name) || a.name.localeCompare(b.name) || a.mint.localeCompare(b.mint)

/**
 * The NFTs a wallet holds. Candidates are the token accounts holding exactly one unit of a zero-decimal
 * mint; those with Token Metadata are NFTs. Only pieces of a verified collection are grouped for sending:
 * a collection parent carries no pointer of its own (the mint engine makes unsized collections, so
 * collection details cannot tell them apart), and offering single NFTs would offer the parents with them.
 */
export async function fetchWalletNfts(connection: Connection, owned: OwnedAccount[]): Promise<WalletNfts> {
  const candidates = owned.filter((a) => a.amount === 1n && a.decimals === 0)
  const mints = new Set<string>()
  if (!candidates.length) return { groups: [], mints }
  const metas = await readNftMetas(connection, candidates.map((a) => new PublicKey(a.mint)))
  const groups = new Map<string, NftGroup>()
  candidates.forEach((a, i) => {
    const m = metas[i]
    // a zero-decimal fungible (points, game items) held as one unit stays a token
    if (!m || m.tokenStandard === 1 || m.tokenStandard === 2) return
    mints.add(a.mint)
    // a frozen piece (staked, or a programmable NFT) is an NFT but cannot be sent by a plain transfer
    if (a.frozen || !m.collection?.verified || !sendable(m.tokenStandard)) return
    const key = m.collection.key
    let g = groups.get(key)
    if (!g) {
      g = { collection: key, name: shortAddr(key, 4, 4), symbol: '', pieces: [] }
      groups.set(key, g)
    }
    g.pieces.push({ mint: a.mint, name: m.name || shortAddr(a.mint, 4, 4), account: a.address, programId: a.programId })
  })
  // collection names from the parents' metadata; a parent without one keeps its short address
  const list = [...groups.values()]
  if (list.length) {
    const parents = await readNftMetas(connection, list.map((g) => new PublicKey(g.collection)))
    list.forEach((g, i) => {
      const m = parents[i]
      if (!m) return
      g.name = m.name || g.name
      g.symbol = m.symbol
    })
  }
  for (const g of list) {
    g.pieces.sort(byName)
    if (!g.symbol) g.symbol = g.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'NFT'
  }
  return { groups: list.sort((a, b) => b.pieces.length - a.pieces.length || a.name.localeCompare(b.name)), mints }
}
