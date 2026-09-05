import { COOK, COOK_DECIMALS, COOK_MINT, REGISTRY_URL } from './chain'

export interface TokenInfo {
  mint: string
  symbol: string
  name: string
  decimals: number
  logo?: string
  holderCount?: number
  verified?: boolean
  priceUsd?: number
  marketCap?: number
  liquidity?: number
  change24h?: number
}

interface RegistryRow {
  mint: string
  symbol?: string
  name?: string
  decimals?: number
  logoUri?: string
  holderCount?: number
  verified?: boolean
  hidden?: boolean
  price?: string | null
  marketCap?: string | null
  liquidity?: string | null
  change24h?: string | number | null
}

const num = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined)

let cache: Promise<Map<string, TokenInfo>> | null = null

/** The Cookiescan token registry (public, CORS-open). One fetch per session; the service worker keeps it fresh. */
export function loadRegistry(): Promise<Map<string, TokenInfo>> {
  if (!cache) {
    cache = fetch(REGISTRY_URL)
      .then((r) => (r.ok ? (r.json() as Promise<RegistryRow[]>) : Promise.reject(new Error(`registry ${r.status}`))))
      .then((rows) => {
        const m = new Map<string, TokenInfo>()
        for (const r of rows) {
          if (!r.mint || r.hidden) continue
          m.set(r.mint, {
            mint: r.mint,
            symbol: r.symbol ?? '',
            name: r.name ?? '',
            decimals: r.decimals ?? 9,
            logo: r.logoUri || undefined,
            holderCount: r.holderCount,
            verified: r.verified,
            priceUsd: num(r.price),
            marketCap: num(r.marketCap),
            liquidity: num(r.liquidity),
            change24h: num(r.change24h),
          })
        }
        // the registry lists native COOK as "wCOOK" under the native mint id; keep its price, fix the name
        const wcook = m.get(COOK_MINT)
        m.set(COOK_MINT, { mint: COOK_MINT, symbol: COOK, name: 'Cookie Chain native token', decimals: COOK_DECIMALS, priceUsd: wcook?.priceUsd, holderCount: wcook?.holderCount, logo: wcook?.logo })
        return m
      })
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}

export function searchRegistry(m: Map<string, TokenInfo>, q: string, limit = 8): TokenInfo[] {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const out: TokenInfo[] = []
  for (const t of m.values()) {
    if (t.mint === COOK_MINT) continue
    if (t.symbol.toLowerCase().startsWith(s) || t.name.toLowerCase().includes(s) || t.mint.startsWith(q.trim())) {
      out.push(t)
      if (out.length >= limit) break
    }
  }
  return out.sort((a, b) => (b.holderCount ?? 0) - (a.holderCount ?? 0))
}
