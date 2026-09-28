import type { Holder } from './das'
import type { TokenInfo } from './tokens'

/** The last snapshot, the snapshots taken before it, and the recent airdrops, kept in this browser so a reload or a killed tab loses nothing. */

export interface StoredSnapshot {
  token: TokenInfo
  holders: Holder[]
  total: bigint
  takenAt: number
  /** Set for an NFT collection: amounts are pieces held. */
  kind?: 'collection'
}

/** One entry per kept snapshot, newest first. The holders live under their own key. */
export interface SavedSnapshot {
  /** The take time as a string; also the storage key suffix. */
  id: string
  mint: string
  symbol: string
  kind?: 'collection'
  takenAt: number
  /** Wallets, program accounts excluded. */
  holders: number
  bytes: number
}

const SNAPSHOT_KEY = 'crumbs.snapshot'
const SAVED_KEY = 'crumbs.snapshots'
const savedKey = (id: string) => `crumbs.snapshot.${id}`
const SNAPSHOT_MAX_HOLDERS = 20_000
const SAVED_PER_MINT = 8
const SAVED_MAX_BYTES = 3_000_000

type Packed = [owner: string, amount: string, accounts: number, isProgram: number, frozen: number]
interface Stored {
  v: 1
  token: TokenInfo
  total: string
  takenAt: number
  kind?: string
  holders: Packed[]
}

function pack(s: StoredSnapshot): Stored {
  const holders = s.holders.map<Packed>((h) => [h.owner, h.amount.toString(), h.accounts, h.isProgram ? 1 : 0, h.frozen ? 1 : 0])
  return { v: 1, token: s.token, total: s.total.toString(), takenAt: s.takenAt, kind: s.kind, holders }
}

function unpack(d: unknown): StoredSnapshot | null {
  const x = d as Stored
  if (!x || x.v !== 1 || !x.token?.mint || typeof x.token.decimals !== 'number' || !Array.isArray(x.holders) || typeof x.takenAt !== 'number') return null
  try {
    return {
      token: x.token,
      total: BigInt(x.total),
      takenAt: x.takenAt,
      kind: x.kind === 'collection' ? 'collection' : undefined,
      holders: x.holders.map(([owner, amount, accounts, isProgram, frozen]) => ({ owner, amount: BigInt(amount), accounts, isProgram: !!isProgram, frozen: !!frozen })),
    }
  } catch {
    return null
  }
}

/** Store the snapshot as the current one and keep it for later comparisons. */
export function saveSnapshot(s: StoredSnapshot) {
  if (s.holders.length > SNAPSHOT_MAX_HOLDERS) return
  const raw = JSON.stringify(pack(s))
  try {
    localStorage.setItem(SNAPSHOT_KEY, raw)
  } catch {
    /* private mode or quota: the snapshot just does not persist */
  }
  keepSnapshot(s, raw)
}

export function loadSnapshot(): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY)
    return raw ? unpack(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function listSaved(mint?: string): SavedSnapshot[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    const list = raw ? (JSON.parse(raw) as SavedSnapshot[]) : []
    return mint ? list.filter((x) => x.mint === mint) : list
  } catch {
    return []
  }
}

export function loadSaved(id: string): StoredSnapshot | null {
  try {
    const raw = localStorage.getItem(savedKey(id))
    return raw ? unpack(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

/**
 * Keep a snapshot for later comparisons without making it the current one (an imported file).
 * Eight per token and about 3 MB in all; the oldest go first, and a full store drops more until the write fits.
 */
export function keepSnapshot(s: StoredSnapshot, raw = JSON.stringify(pack(s))) {
  const id = String(s.takenAt)
  const entry: SavedSnapshot = { id, mint: s.token.mint, symbol: s.token.symbol, kind: s.kind, takenAt: s.takenAt, holders: s.holders.filter((h) => !h.isProgram).length, bytes: raw.length }
  let list = [entry, ...listSaved().filter((x) => x.id !== id)].sort((a, b) => b.takenAt - a.takenAt)
  const evicted: SavedSnapshot[] = []
  const evict = (x: SavedSnapshot) => {
    evicted.push(x)
    list = list.filter((y) => y.id !== x.id)
  }
  // per-token cap: the newest eight stay
  const perMint = new Map<string, number>()
  for (const x of [...list]) {
    const n = (perMint.get(x.mint) ?? 0) + 1
    perMint.set(x.mint, n)
    if (n > SAVED_PER_MINT) evict(x)
  }
  // byte cap: oldest out, never the one being kept
  while (list.reduce((n, x) => n + x.bytes, 0) > SAVED_MAX_BYTES && list.length > 1) evict(list[list.length - 1])
  try {
    for (;;) {
      try {
        localStorage.setItem(savedKey(id), raw)
        break
      } catch (e) {
        // quota: make room, oldest first; give up when nothing else can go
        const oldest = list.filter((x) => x.id !== id).pop()
        if (!oldest) throw e
        evict(oldest)
        localStorage.removeItem(savedKey(oldest.id))
      }
    }
    for (const x of evicted) localStorage.removeItem(savedKey(x.id))
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    /* private mode or full: the snapshot just does not persist */
  }
}

/** The snapshot as a file, the same shape the store uses. */
export function snapshotJson(s: StoredSnapshot): string {
  return JSON.stringify(pack(s))
}

/** A snapshot from a file this app exported. Throws when the file is something else. */
export function parseSnapshotJson(text: string): StoredSnapshot {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error('That file is not a Crumbs snapshot.')
  }
  const s = unpack(d)
  if (!s) throw new Error('That file is not a Crumbs snapshot.')
  if (s.holders.length > SNAPSHOT_MAX_HOLDERS) throw new Error('That snapshot is too large to keep here.')
  return s
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
