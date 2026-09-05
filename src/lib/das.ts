import { PublicKey } from '@solana/web3.js'
import { DAS_URL } from './chain'

export interface Holder {
  owner: string
  /** Sum of every token account this owner holds for the mint. */
  amount: bigint
  accounts: number
  /** Off-curve owners are program addresses: pools, vaults, escrows. */
  isProgram: boolean
  frozen: boolean
}

interface DasTokenAccount {
  address: string
  mint: string
  owner: string
  amount: number | string
  delegated_amount?: number | string
  frozen?: boolean
}

interface DasTokenAccountsResult {
  total: number
  limit: number
  page: number
  token_accounts: DasTokenAccount[]
}

async function das<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(DAS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  })
  if (!res.ok) throw new Error(`DAS ${res.status}`)
  const json = (await res.json()) as { result?: T; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

const PAGE = 1000

/**
 * Every holder of a mint, aggregated by owner, largest first. Pages through the Cookiescan DAS
 * getTokenAccounts index; `onProgress` gets the running account count.
 */
export async function fetchHolders(
  mint: string,
  onProgress?: (accounts: number) => void,
  signal?: AbortSignal,
): Promise<Holder[]> {
  const byOwner = new Map<string, Holder>()
  let page = 1
  let seen = 0
  for (;;) {
    const r = await das<DasTokenAccountsResult>(
      'getTokenAccounts',
      { mint, page, limit: PAGE, options: { showZeroBalance: false } },
      signal,
    )
    const rows = r.token_accounts ?? []
    for (const a of rows) {
      const amt = BigInt(String(a.amount))
      if (amt === 0n) continue
      const h = byOwner.get(a.owner)
      if (h) {
        h.amount += amt
        h.accounts += 1
        h.frozen = h.frozen || !!a.frozen
      } else {
        byOwner.set(a.owner, {
          owner: a.owner,
          amount: amt,
          accounts: 1,
          isProgram: !PublicKey.isOnCurve(new PublicKey(a.owner).toBytes()),
          frozen: !!a.frozen,
        })
      }
    }
    seen += rows.length
    onProgress?.(seen)
    if (rows.length < PAGE) break
    page += 1
    if (page > 200) break // 200k accounts: past any real token on this chain
  }
  return [...byOwner.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
}
