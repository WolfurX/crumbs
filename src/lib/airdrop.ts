import { PublicKey, SystemProgram, type Connection, type TransactionInstruction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { COOK_MINT, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_RENT, TOKEN_PROGRAM } from './chain'
import { shortAddr } from './format'
import { packBatches, type Batch } from './txs'

export type Asset =
  | { kind: 'native'; symbol: 'COOK'; decimals: 9 }
  | { kind: 'token'; mint: PublicKey; decimals: number; programId: PublicKey; symbol: string }

export interface Recipient {
  owner: string
  amount: bigint
}

export interface AirdropPlan {
  asset: Asset
  recipients: Recipient[]
  batches: Batch[]
  totalAmount: bigint
  /** Token accounts that will be created for recipients (paid by the sender, reclaimable by them). */
  ataCreates: number
  rentLamports: bigint
  /** Base fee estimate: one signature per transaction. */
  feeLamports: bigint
  /** Recipients dropped because their address is not valid. */
  invalid: string[]
  /** COOK only: recipients dropped because the amount would leave a brand-new account under the rent minimum. */
  belowRent: number
  /** COOK only: the smallest amount an empty wallet can receive. */
  rentMinimum: bigint
}

/** Resolve a mint into an Asset: native COOK, or a token with its program and decimals read on chain. */
export async function resolveAsset(connection: Connection, mint: string, symbol?: string): Promise<Asset> {
  if (mint === COOK_MINT) return { kind: 'native', symbol: 'COOK', decimals: 9 }
  const pk = new PublicKey(mint)
  const info = await connection.getAccountInfo(pk)
  if (!info) throw new Error('Mint not found on Cookie Chain')
  const programId = info.owner.equals(TOKEN_2022_PROGRAM) ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM
  const m = await getMint(connection, pk, 'confirmed', programId)
  return { kind: 'token', mint: pk, decimals: m.decimals, programId, symbol: symbol || shortAddr(mint, 4, 4) }
}

const UNITS_TRANSFER = 8_000
const UNITS_ATA_CREATE = 30_000

export async function planAirdrop(connection: Connection, sender: PublicKey, asset: Asset, raw: Recipient[]): Promise<AirdropPlan> {
  const invalid: string[] = []
  const recipients: Recipient[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    let pk: PublicKey
    try {
      pk = new PublicKey(r.owner.trim())
    } catch {
      invalid.push(r.owner)
      continue
    }
    const key = pk.toBase58()
    if (r.amount <= 0n || seen.has(key)) continue
    seen.add(key)
    recipients.push({ owner: key, amount: r.amount })
  }

  const items: TransactionInstruction[][] = []
  let ataCreates = 0
  let belowRent = 0
  let rentMinimum = 0n
  if (asset.kind === 'native') {
    // A system account must end up rent exempt (about 0.00089 COOK), or the transfer fails. Wallets
    // that do not exist yet, or sit below that line, need at least the difference.
    rentMinimum = BigInt(await connection.getMinimumBalanceForRentExemption(0))
    const infos = await accountLamports(connection, recipients.map((r) => new PublicKey(r.owner)))
    const kept: Recipient[] = []
    recipients.forEach((r, i) => {
      if (infos[i] + r.amount < rentMinimum) {
        belowRent += 1
        return
      }
      kept.push(r)
      items.push([SystemProgram.transfer({ fromPubkey: sender, toPubkey: new PublicKey(r.owner), lamports: r.amount })])
    })
    recipients.length = 0
    recipients.push(...kept)
  } else {
    const source = getAssociatedTokenAddressSync(asset.mint, sender, false, asset.programId)
    const atas = recipients.map((r) => getAssociatedTokenAddressSync(asset.mint, new PublicKey(r.owner), true, asset.programId))
    const exists = await accountsExist(connection, atas)
    recipients.forEach((r, i) => {
      const ixs: TransactionInstruction[] = []
      if (!exists[i]) {
        ataCreates += 1
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(sender, atas[i], new PublicKey(r.owner), asset.mint, asset.programId))
      }
      ixs.push(createTransferCheckedInstruction(source, asset.mint, atas[i], sender, r.amount, asset.decimals, [], asset.programId))
      items.push(ixs)
    })
  }

  const batches = packBatches(sender, items, (item) => (item.length > 1 ? UNITS_ATA_CREATE + UNITS_TRANSFER : UNITS_TRANSFER))
  return {
    asset,
    recipients,
    batches,
    totalAmount: recipients.reduce((n, r) => n + r.amount, 0n),
    ataCreates,
    rentLamports: BigInt(ataCreates) * TOKEN_ACCOUNT_RENT,
    feeLamports: BigInt(batches.length) * 5_000n,
    invalid,
    belowRent,
    rentMinimum,
  }
}

/** Current lamports per account, 0 for accounts that do not exist. */
async function accountLamports(connection: Connection, keys: PublicKey[]): Promise<bigint[]> {
  const out: bigint[] = new Array(keys.length).fill(0n)
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))
    infos.forEach((info, j) => (out[i + j] = BigInt(info?.lamports ?? 0)))
  }
  return out
}

async function accountsExist(connection: Connection, keys: PublicKey[]): Promise<boolean[]> {
  const out: boolean[] = new Array(keys.length).fill(false)
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(chunk)
    infos.forEach((info, j) => (out[i + j] = !!info))
  }
  return out
}

/** Split `total` across holders in proportion to their balances; dust from rounding stays with the sender. */
export function proRata(total: bigint, weights: { owner: string; weight: bigint }[]): Recipient[] {
  const sum = weights.reduce((n, w) => n + w.weight, 0n)
  if (sum === 0n) return []
  return weights.map((w) => ({ owner: w.owner, amount: (total * w.weight) / sum })).filter((r) => r.amount > 0n)
}

/** "address, amount" or "address amount" per line; amount optional when a default is given. */
export function parseRecipientList(text: string, decimalsToRaw: (ui: string) => bigint, defaultAmount?: bigint): { recipients: Recipient[]; errors: string[] } {
  const recipients: Recipient[] = []
  const errors: string[] = []
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    const [addr, amt] = t.split(/[,\s;]+/)
    try {
      const amount = amt ? decimalsToRaw(amt) : defaultAmount
      if (amount === undefined) throw new Error('no amount')
      recipients.push({ owner: addr, amount })
    } catch (e) {
      errors.push(`line ${i + 1}: ${(e as Error).message}`)
    }
  })
  return { recipients, errors }
}
