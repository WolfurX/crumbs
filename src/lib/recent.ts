export interface RecentSnapshot {
  mint: string
  symbol: string
  holders: number
  takenAt: number
}

const KEY = 'crumbs.recent'
const MAX = 6

export function loadRecent(): RecentSnapshot[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as RecentSnapshot[]) : []
  } catch {
    return []
  }
}

export function pushRecent(r: RecentSnapshot): RecentSnapshot[] {
  const list = [r, ...loadRecent().filter((x) => x.mint !== r.mint)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode or full: the list just does not persist */
  }
  return list
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
