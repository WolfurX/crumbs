import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js'
import { MAX_TX_BYTES } from './chain'

export type BatchStatus = 'pending' | 'signing' | 'sending' | 'confirming' | 'confirmed' | 'failed' | 'expired'

export interface Batch {
  id: number
  /** Instructions per logical item (one recipient, one account), kept so a batch can be rebuilt. */
  items: TransactionInstruction[][]
  /** Compute units the batch asks for; sized from its contents. */
  computeUnits: number
  status: BatchStatus
  signature?: string
  error?: string
}

export interface Signer {
  publicKey: PublicKey
  signTransaction<T extends Transaction>(tx: T): Promise<T>
  signAllTransactions?<T extends Transaction>(txs: T[]): Promise<T[]>
}

// Any valid 32-byte base58 string works as a sizing placeholder for the blockhash.
const SIZING_BLOCKHASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EuQgCeW'

function serializedSize(feePayer: PublicKey, ixs: TransactionInstruction[]): number {
  const tx = new Transaction({ feePayer, recentBlockhash: SIZING_BLOCKHASH })
  tx.add(...ixs)
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length
}

/**
 * Pack items into as few transactions as fit under the 1232-byte limit. Each item stays whole
 * (an account create plus its transfer never split across transactions).
 */
export function packBatches(
  feePayer: PublicKey,
  items: TransactionInstruction[][],
  unitsPerItem: (item: TransactionInstruction[]) => number,
  maxItems = 24,
): Batch[] {
  const batches: Batch[] = []
  let cur: TransactionInstruction[][] = []
  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
  const flush = () => {
    if (!cur.length) return
    const units = Math.min(1_400_000, 10_000 + cur.reduce((n, it) => n + unitsPerItem(it), 0))
    batches.push({ id: batches.length + 1, items: cur, computeUnits: units, status: 'pending' })
    cur = []
  }
  for (const item of items) {
    const trial = [budgetIx, ...cur.flat(), ...item]
    if (cur.length && (cur.length >= maxItems || serializedSize(feePayer, trial) > MAX_TX_BYTES)) flush()
    cur.push(item)
  }
  flush()
  return batches
}

export function batchToTransaction(b: Batch, feePayer: PublicKey, blockhash: string): Transaction {
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash })
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: b.computeUnits }))
  for (const item of b.items) tx.add(...item)
  return tx
}

/** Turn an RPC/program error into one line a person can act on. */
export function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const logs = (e as { logs?: string[] })?.logs?.join(' ') ?? ''
  const blob = `${msg} ${logs}`
  if (/insufficient lamports|insufficient funds for rent/i.test(blob)) return 'Not enough COOK to pay fees and account rent.'
  if (/insufficient funds|custom program error: 0x1\b/i.test(blob)) return 'Not enough of the token in your wallet.'
  if (/User rejected|rejected the request|declined/i.test(blob)) return 'You declined the signature in the wallet.'
  if (/Blockhash not found|block height exceeded/i.test(blob)) return 'The transaction expired before it landed. Retry it.'
  if (/frozen|0x11\b/i.test(blob)) return 'A token account in this batch is frozen.'
  return msg.length > 160 ? msg.slice(0, 157) + '…' : msg
}

export interface RunOptions {
  connection: Connection
  signer: Signer
  batches: Batch[]
  onUpdate: (b: Batch) => void
  /** Only batches in these statuses are run; the rest are left as they are. */
  only?: BatchStatus[]
}

/**
 * Sign every runnable batch in one wallet prompt (when the wallet supports it), then send and
 * confirm them one after another so the status list reads top to bottom. Expired ones are marked
 * so the caller can offer a retry against a fresh blockhash.
 */
export async function runBatches({ connection, signer, batches, onUpdate, only = ['pending', 'failed', 'expired'] }: RunOptions) {
  const todo = batches.filter((b) => only.includes(b.status))
  if (!todo.length) return
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const txs = todo.map((b) => batchToTransaction(b, signer.publicKey, blockhash))

  for (const b of todo) {
    b.status = 'signing'
    b.error = undefined
    onUpdate(b)
  }
  let signed: Transaction[]
  try {
    const signing = signer.signAllTransactions ? signer.signAllTransactions(txs) : sequentialSign(signer, txs)
    signed = await withTimeout(signing, SIGN_TIMEOUT_MS)
  } catch (e) {
    for (const b of todo) {
      b.status = 'failed'
      b.error = explainError(e)
      onUpdate(b)
    }
    return
  }

  for (let i = 0; i < todo.length; i++) {
    const b = todo[i]
    try {
      b.status = 'sending'
      onUpdate(b)
      const sig = await connection.sendRawTransaction(signed[i].serialize(), { maxRetries: 3 })
      b.signature = sig
      b.status = 'confirming'
      onUpdate(b)
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
      if (res.value.err) throw new Error(`On-chain error: ${JSON.stringify(res.value.err)}`)
      b.status = 'confirmed'
    } catch (e) {
      b.status = e instanceof TransactionExpiredBlockheightExceededError ? 'expired' : 'failed'
      b.error = explainError(e)
    }
    onUpdate(b)
  }
}

// Nightly and friends simulate on the network they are set to before signing. Pointed at Solana
// mainnet, a Cookie Chain transaction "fails" there and the wallet never answers, so we stop waiting.
const SIGN_TIMEOUT_MS = 120_000
export const WRONG_NETWORK_HINT = 'The wallet did not return a signature. Make sure it is on Cookie Chain: in Nightly, open the network switcher and pick Cookie, then try again.'

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(WRONG_NETWORK_HINT)), ms)
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)))
  })
}

async function sequentialSign(signer: Signer, txs: Transaction[]): Promise<Transaction[]> {
  const out: Transaction[] = []
  for (const tx of txs) out.push(await signer.signTransaction(tx))
  return out
}
