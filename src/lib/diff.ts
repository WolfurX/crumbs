import type { Holder } from './das'

/** Who joined, who left, whose balance moved between two snapshots of the same token. */

export type Change = 'joined' | 'left' | 'grew' | 'shrank'

export interface HolderChange {
  owner: string
  before: bigint
  after: bigint
  /** after minus before; the whole balance for a wallet that joined or left. */
  delta: bigint
  change: Change
  isProgram: boolean
}

export interface HolderDiff {
  /** Every wallet whose balance differs, biggest move first. */
  rows: HolderChange[]
  counts: Record<Change, number>
  holdersBefore: number
  holdersAfter: number
  heldBefore: bigint
  heldAfter: bigint
}

const abs = (n: bigint) => (n < 0n ? -n : n)

export function diffHolders(before: Holder[], after: Holder[]): HolderDiff {
  const prev = new Map(before.map((h) => [h.owner, h]))
  const rows: HolderChange[] = []
  const counts: Record<Change, number> = { joined: 0, left: 0, grew: 0, shrank: 0 }
  const push = (r: HolderChange) => {
    rows.push(r)
    counts[r.change]++
  }
  for (const h of after) {
    const p = prev.get(h.owner)
    if (!p) push({ owner: h.owner, before: 0n, after: h.amount, delta: h.amount, change: 'joined', isProgram: h.isProgram })
    else if (h.amount > p.amount) push({ owner: h.owner, before: p.amount, after: h.amount, delta: h.amount - p.amount, change: 'grew', isProgram: h.isProgram })
    else if (h.amount < p.amount) push({ owner: h.owner, before: p.amount, after: h.amount, delta: h.amount - p.amount, change: 'shrank', isProgram: h.isProgram })
    prev.delete(h.owner)
  }
  for (const p of prev.values()) push({ owner: p.owner, before: p.amount, after: 0n, delta: -p.amount, change: 'left', isProgram: p.isProgram })
  rows.sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : a.owner.localeCompare(b.owner)))
  return {
    rows,
    counts,
    holdersBefore: before.length,
    holdersAfter: after.length,
    heldBefore: before.reduce((n, h) => n + h.amount, 0n),
    heldAfter: after.reduce((n, h) => n + h.amount, 0n),
  }
}

/** "+1,250" or "-3" style, from a formatter for the unsigned amount. */
export function fmtDelta(delta: bigint, fmt: (n: bigint) => string): string {
  return (delta < 0n ? '−' : '+') + fmt(abs(delta))
}
