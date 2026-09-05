/**
 * Swap by link. Two wallets trade tokens in one atomic transaction, no escrow, no program:
 * the maker builds the transaction (their leg out, the taker's leg back), signs their part against a
 * durable nonce so it does not expire in a minute, and shares it as a link. The taker's wallet adds
 * the second signature and sends. Cancelling is advancing the nonce.
 */
import { Buffer } from 'buffer'
import { Connection, NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram, SystemInstruction, Transaction, TransactionInstruction, type Signer } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { COOK_MINT } from '../lib/chain'

export interface Leg {
  /** COOK_MINT for native COOK. */
  mint: string
  amount: bigint
  decimals: number
  programId?: PublicKey
}

export interface Offer {
  maker: PublicKey
  taker: PublicKey
  give: Leg // maker -> taker
  get: Leg // taker -> maker
  nonceAccount: PublicKey
  nonce: string
  tx: Transaction
}

const nonceKey = (owner: PublicKey) => `crumbs.nonce.${owner.toBase58()}`

export function savedNonce(owner: PublicKey): PublicKey | null {
  try {
    const v = localStorage.getItem(nonceKey(owner))
    return v ? new PublicKey(v) : null
  } catch {
    return null
  }
}
export function rememberNonce(owner: PublicKey, nonce: PublicKey) {
  try { localStorage.setItem(nonceKey(owner), nonce.toBase58()) } catch { /* ignore */ }
}

/** Instructions that create a durable nonce account owned by `owner` (owner pays ~0.0015 COOK rent). */
export async function createNonceIxs(connection: Connection, owner: PublicKey, nonceKeypair: Signer): Promise<TransactionInstruction[]> {
  const lamports = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)
  return [
    SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: nonceKeypair.publicKey, lamports, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
    SystemProgram.nonceInitialize({ noncePubkey: nonceKeypair.publicKey, authorizedPubkey: owner }),
  ]
}

export async function readNonce(connection: Connection, nonceAccount: PublicKey): Promise<NonceAccount | null> {
  return connection.getNonce(nonceAccount, 'confirmed')
}

export async function resolveLeg(connection: Connection, mint: string, amountUi: string): Promise<Leg> {
  if (mint === COOK_MINT) return { mint, amount: toRaw(amountUi, 9), decimals: 9 }
  const pk = new PublicKey(mint)
  const info = await connection.getAccountInfo(pk)
  if (!info) throw new Error('Mint not found on Cookie Chain')
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const m = await getMint(connection, pk, 'confirmed', programId)
  return { mint, amount: toRaw(amountUi, m.decimals), decimals: m.decimals, programId }
}

function toRaw(ui: string, decimals: number): bigint {
  const t = ui.trim()
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') throw new Error(`Not a number: "${ui}"`)
  const [i, f = ''] = t.split('.')
  if (f.length > decimals) throw new Error(`More than ${decimals} decimals`)
  return BigInt((i || '0') + f.padEnd(decimals, '0'))
}

function legIxs(from: PublicKey, to: PublicKey, leg: Leg, payer: PublicKey): TransactionInstruction[] {
  if (leg.mint === COOK_MINT) return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: leg.amount })]
  const mint = new PublicKey(leg.mint)
  const pid = leg.programId ?? TOKEN_PROGRAM_ID
  const src = getAssociatedTokenAddressSync(mint, from, false, pid)
  const dst = getAssociatedTokenAddressSync(mint, to, false, pid)
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, dst, to, mint, pid),
    createTransferCheckedInstruction(src, mint, dst, from, leg.amount, leg.decimals, [], pid),
  ]
}

/**
 * The unsigned swap transaction. Fee payer is the taker, so the maker's signature costs nothing and
 * the taker pays fees plus any token account rent. Nonce advance is the first instruction.
 */
export function buildOfferTx(maker: PublicKey, taker: PublicKey, give: Leg, get: Leg, nonceAccount: PublicKey, nonce: string): Transaction {
  const tx = new Transaction({ feePayer: taker, nonceInfo: { nonce, nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: maker }) } })
  tx.add(...legIxs(maker, taker, give, taker), ...legIxs(taker, maker, get, taker))
  return tx
}

export function encodeOffer(tx: Transaction): string {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  return Buffer.from(bytes).toString('base64url')
}

export function offerLink(encoded: string): string {
  return `${location.origin}${location.pathname}#swap=${encoded}`
}

export function offerFromHash(hash = location.hash): string | null {
  const m = /[#&]swap=([A-Za-z0-9_-]+)/.exec(hash)
  return m ? m[1] : null
}

/**
 * Decode a link and check it is exactly the shape this app builds. Throws on anything else, so a
 * taker never signs an instruction they did not see described.
 */
export function decodeOffer(encoded: string): Offer {
  const tx = Transaction.from(Buffer.from(encoded, 'base64url'))
  if (!tx.feePayer) throw new Error('No fee payer')
  const ixs = tx.instructions
  if (ixs.length < 3 || ixs.length > 5) throw new Error('Unexpected instruction count')
  // 1. nonce advance by the maker
  const first = ixs[0]
  if (!first.programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(first) !== 'AdvanceNonceAccount') throw new Error('First instruction is not a nonce advance')
  const adv = SystemInstruction.decodeNonceAdvance(first)
  const maker = adv.authorizedPubkey
  const taker = tx.feePayer
  const nonceAccount = adv.noncePubkey
  // 2. the legs
  const legs: { from: PublicKey; to: PublicKey; leg: Leg }[] = []
  for (const ix of ixs.slice(1)) {
    if (ix.programId.equals(SystemProgram.programId)) {
      if (SystemInstruction.decodeInstructionType(ix) !== 'Transfer') throw new Error('Unexpected system instruction')
      const t = SystemInstruction.decodeTransfer(ix)
      legs.push({ from: t.fromPubkey, to: t.toPubkey, leg: { mint: COOK_MINT, amount: BigInt(t.lamports), decimals: 9 } })
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (ix.data.length > 1 || (ix.data.length === 1 && ix.data[0] !== 1)) throw new Error('Unexpected associated token instruction')
      if (!ix.keys[0].pubkey.equals(taker)) throw new Error('Token account rent must be paid by the taker')
    } else if (ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID)) {
      const t = decodeTransferCheckedInstruction(ix, ix.programId)
      // destination ATA owner is whichever party is not the source owner
      const from = t.keys.owner.pubkey
      const to = from.equals(maker) ? taker : maker
      const expectedDst = getAssociatedTokenAddressSync(t.keys.mint.pubkey, to, false, ix.programId)
      if (!t.keys.destination.pubkey.equals(expectedDst)) throw new Error('Transfer destination is not the counterparty')
      legs.push({ from, to, leg: { mint: t.keys.mint.pubkey.toBase58(), amount: BigInt(t.data.amount.toString()), decimals: t.data.decimals, programId: ix.programId } })
    } else {
      throw new Error('Unexpected program in offer')
    }
  }
  if (legs.length !== 2) throw new Error('An offer has exactly two legs')
  const give = legs.find((l) => l.from.equals(maker) && l.to.equals(taker))
  const get = legs.find((l) => l.from.equals(taker) && l.to.equals(maker))
  if (!give || !get) throw new Error('Legs do not connect maker and taker')
  // 3. the maker's signature must already be there and valid
  const sig = tx.signatures.find((s) => s.publicKey.equals(maker))
  if (!sig?.signature) throw new Error('Offer is not signed by the maker')
  if (!tx.verifySignatures(false)) throw new Error('Maker signature does not verify')
  return { maker, taker, give: give.leg, get: get.leg, nonceAccount, nonce: tx.recentBlockhash!, tx }
}

/** Is the offer still open? The nonce account's current value must equal the offer's blockhash. */
export async function offerIsOpen(connection: Connection, offer: Offer): Promise<boolean> {
  const n = await readNonce(connection, offer.nonceAccount)
  return !!n && n.nonce === offer.nonce
}

export function cancelIx(maker: PublicKey, nonceAccount: PublicKey): TransactionInstruction {
  return SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: maker })
}

/** Dry-run the offer as the chain would execute it now. Missing signatures are allowed; balances are not. */
export async function simulateOffer(connection: Connection, offer: Offer): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await connection.simulateTransaction(offer.tx, undefined, false)
    if (r.value.err) {
      const logs = r.value.logs?.join(' ') ?? ''
      if (/insufficient funds|Error: insufficient/i.test(logs)) return { ok: false, reason: 'One side does not hold enough for its leg right now.' }
      if (/InvalidAccountData|could not find account|AccountNotFound/i.test(logs)) return { ok: false, reason: 'The maker no longer holds the token account for their leg.' }
      return { ok: false, reason: `Would fail: ${JSON.stringify(r.value.err)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}
