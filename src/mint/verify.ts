// Creator verification for a finished drop. Every piece lists the creator unverified (the session
// key minted it, and only the creator's own signature can flip the flag), so the wallet signs one
// SignMetadata per piece, packed into as few transactions as fit.
import { PublicKey, type Connection } from '@solana/web3.js'
import { readNftMetas } from '../lib/collection'
import { packBatches, type Batch } from '../lib/txs'
import { signMetadataIx } from './tm'

export interface VerifyPlan {
  batches: Batch[]
  /** Pieces still to sign. */
  unverified: number
  /** Pieces already showing the creator as verified. */
  verified: number
  /** Pieces without metadata, or that do not list this creator; nothing to sign there. */
  missing: number
}

// SignMetadata deserialises the whole metadata account: 12.4k to 12.9k units measured on Cookie Chain (2026-09-26)
const UNITS_SIGN = 16_000

/** Which of `mints` still carry `creator` unverified, and the transactions that sign them. */
export async function planCreatorVerify(connection: Connection, creator: PublicKey, mints: string[]): Promise<VerifyPlan> {
  const me = creator.toBase58()
  const metas = await readNftMetas(connection, mints.map((m) => new PublicKey(m)))
  const todo: PublicKey[] = []
  let verified = 0
  let missing = 0
  metas.forEach((m, i) => {
    const c = m?.creators.find((x) => x.address === me)
    if (!c) missing += 1
    else if (c.verified) verified += 1
    else todo.push(new PublicKey(mints[i]))
  })
  const batches = packBatches(creator, todo.map((mint) => [signMetadataIx(mint, creator)]), () => UNITS_SIGN)
  return { batches, unverified: todo.length, verified, missing }
}
