import type { Holder } from './das'
import type { TokenInfo } from './tokens'

/** The last snapshot and the recent airdrops, kept in this browser so a reload or a killed tab loses nothing. */

export interface StoredSnapshot {
  token: TokenInfo
  holders: Holder[]
  total: bigint
  takenAt: number
  /** Set for an NFT collection: amounts are pieces held. */
  kind?: 'collection'
}

const SNAPSHOT_KEY = 'crumbs.snapshot'
const SNAPSHOT_MAX_HOLDERS = 20_000

export function saveSnapshot(s: StoredSnapshot) {
  if (s.holders.length > SNAPSHOT_MAX_HOLDERS) return
  try {
    const holders = s.holders.map((h) => [h.owner, h.amount.toString(), h.accounts, h.isProgram ? 1 : 0, h.frozen ? 1 : 0])
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 1, token: s.token, total: s.total.toString(), takenAt: s.takenAt, kind: s.kind, holders }))
  } catch {
    /* private mode or quota: the snapshot just does not persist */
  }
}

export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as { v: number; token: TokenInfo; total: string; takenAt: number; kind?: string; holders: [string, string, number, number, number][] }
    if (d.v !== 1 || !d.token?.mint || !Array.isArray(d.holders)) return null
    return {
      token: d.token,
      total: BigInt(d.total),
      takenAt: d.takenAt,
      kind: d.kind === 'collection' ? 'collection' : undefined,
      holders: d.holders.map(([owner, amount, accounts, isProgram, frozen]) => ({ owner, amount: BigInt(amount), accounts, isProgram: !!isProgram, frozen: !!frozen })),
    }
  } catch {
    return null
  }
}

export interface AirdropRecord {
  /** Plan identity, so retries update the same entry. */
  id: number
  at: number
  symbol: string
  decimals: number
  /** Raw total as a string; JSON has no bigint. */
  total: string
  recipients: number
  /** Confirmed transaction signatures, in batch order. */
  signatures: string[]
  /** An NFT drop: `total` counts pieces, one per wallet. */
  pieces?: boolean
}

const AIRDROPS_KEY = 'crumbs.airdrops'
const AIRDROPS_MAX = 20

export function loadAirdrops(): AirdropRecord[] {
  try {
    const raw = localStorage.getItem(AIRDROPS_KEY)
    return raw ? (JSON.parse(raw) as AirdropRecord[]) : []
  } catch {
    return []
  }
}

export function recordAirdrop(r: AirdropRecord): AirdropRecord[] {
  const list = [r, ...loadAirdrops().filter((x) => x.id !== r.id)].slice(0, AIRDROPS_MAX)
  try {
    localStorage.setItem(AIRDROPS_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
  return list
}
