import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js'
import { createCloseAccountInstruction, createRevokeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './chain'
import { packBatches, type Batch } from './txs'

export interface OwnedAccount {
  address: string
  mint: string
  programId: PublicKey
  amount: bigint
  decimals: number
  delegate?: string
  delegatedAmount: bigint
  frozen: boolean
  isAta: boolean
  /** Lamports locked as rent, returned to you when the account is closed. */
  rent: bigint
}

interface ParsedTokenInfo {
  mint: string
  owner: string
  state: string
  delegate?: string
  delegatedAmount?: { amount: string }
  tokenAmount: { amount: string; decimals: number }
}

/** Every token account the wallet owns, across both token programs. */
export async function fetchOwnedAccounts(connection: Connection, owner: PublicKey): Promise<OwnedAccount[]> {
  const out: OwnedAccount[] = []
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { programId })
    for (const { pubkey, account } of res.value) {
      const info = (account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info
      const ata = getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, false, programId)
      out.push({
        address: pubkey.toBase58(),
        mint: info.mint,
        programId,
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        delegate: info.delegate,
        delegatedAmount: BigInt(info.delegatedAmount?.amount ?? '0'),
        frozen: info.state === 'frozen',
        isAta: ata.equals(pubkey),
        rent: BigInt(account.lamports),
      })
    }
  }
  return out
}

export function revokeItem(acc: OwnedAccount, owner: PublicKey): TransactionInstruction[] {
  return [createRevokeInstruction(new PublicKey(acc.address), owner, [], acc.programId)]
}

/** Close an empty account; its rent goes back to the owner. */
export function closeItem(acc: OwnedAccount, owner: PublicKey): TransactionInstruction[] {
  return [createCloseAccountInstruction(new PublicKey(acc.address), owner, owner, [], acc.programId)]
}

export function packCleanup(owner: PublicKey, items: TransactionInstruction[][]): Batch[] {
  return packBatches(owner, items, () => 6_000, 20)
}
