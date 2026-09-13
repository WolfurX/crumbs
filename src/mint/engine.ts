// The two stages of a quick drop. Stage one funds a throwaway session key and streams the picture
// and one metadata JSON per piece into crumb_store blobs. Stage two has the wallet sign the
// collection NFT and one transaction per piece. Every step is idempotent against the saved state.
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js'
import { MINT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram } from '@solana/web3.js'
import bs58 from 'bs58'
import { TOKEN_PROGRAM } from '../lib/chain'
import { explainError, type Signer } from '../lib/txs'
import { blobUrl, blockhashCache, newUploadState, pool, sendSigned, uploadBlob, type UploadState } from './blob'
import { createMasterEditionV3Ix, createMetadataV3Ix, verifyCollectionIx } from './tm'
import { estimate, fetchRents, pieceJson, pieceName, PIECES_PER_APPROVAL, type DropForm } from './plan'

export type Stage = 'store' | 'mint' | 'done'

export interface PieceState { mint: string; secret: string; done: boolean; sig?: string }

export interface DropState {
  v: 1
  owner: string
  createdAt: number
  updatedAt: number
  form: DropForm
  /** One wallet per piece, in order. */
  recipients: string[]
  image: { mime: string; b64: string; width: number; height: number }
  session: string
  stage: Stage
  funded?: string
  imageBlob: UploadState
  collectionBlob: UploadState
  pieceBlobs: UploadState[]
  collection: PieceState
  pieces: PieceState[]
  refunded?: boolean
}

const key = (owner: PublicKey | string) => `crumbs.drop.${typeof owner === 'string' ? owner : owner.toBase58()}`

export function loadDrop(owner: PublicKey): DropState | null {
  try {
    const raw = localStorage.getItem(key(owner))
    const s = raw ? (JSON.parse(raw) as DropState) : null
    return s && s.v === 1 ? s : null
  } catch {
    return null
  }
}

export function saveDrop(s: DropState) {
  s.updatedAt = Date.now()
  try {
    localStorage.setItem(key(s.owner), JSON.stringify(s))
  } catch {
    // quota or private mode: the drop still runs, it just cannot resume
  }
}

export function forgetDrop(owner: PublicKey | string) {
  try {
    localStorage.removeItem(key(owner))
  } catch {
    // nothing to forget
  }
}

const b64 = {
  encode: (u: Uint8Array) => {
    let s = ''
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
    return btoa(s)
  },
  decode: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}

const newPiece = (): PieceState => {
  const kp = Keypair.generate()
  return { mint: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey), done: false }
}

export function newDrop(owner: PublicKey, form: DropForm, recipients: PublicKey[], image: { bytes: Uint8Array; mime: string; width: number; height: number }): DropState {
  const s: DropState = {
    v: 1,
    owner: owner.toBase58(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    form,
    recipients: recipients.map((r) => r.toBase58()),
    image: { mime: image.mime, b64: b64.encode(image.bytes), width: image.width, height: image.height },
    session: bs58.encode(Keypair.generate().secretKey),
    stage: 'store',
    imageBlob: newUploadState(),
    collectionBlob: newUploadState(),
    pieceBlobs: recipients.map(() => newUploadState()),
    collection: newPiece(),
    pieces: recipients.map(() => newPiece()),
  }
  saveDrop(s)
  return s
}

export interface Progress {
  stage: Stage
  /** Picture chunks. */
  chunksDone: number
  chunksTotal: number
  labelsDone: number
  labelsTotal: number
  piecesDone: number
  piecesTotal: number
  /** What the wallet is being asked right now, if anything. */
  prompt?: string
  /** Latest one-line note: a retry, a wait. */
  note?: string
}

export interface Hooks {
  onProgress: (p: Progress) => void
}

const COLLECTION_UNITS = 260_000
const PIECE_UNITS = 300_000

function progressOf(s: DropState, extra: Partial<Progress> = {}): Progress {
  const imageSize = Math.ceil((s.image.b64.length * 3) / 4)
  const chunksTotal = imageSize <= 700 ? 1 : Math.ceil(imageSize / 1000)
  const chunksDone = s.imageBlob.finalized ? chunksTotal : s.imageBlob.chunks.length
  return {
    stage: s.stage,
    chunksDone,
    chunksTotal,
    labelsDone: (s.collectionBlob.finalized ? 1 : 0) + s.pieceBlobs.filter((b) => b.finalized).length,
    labelsTotal: s.pieceBlobs.length + 1,
    piecesDone: (s.collection.done ? 1 : 0) + s.pieces.filter((p) => p.done).length,
    piecesTotal: s.pieces.length + 1,
    ...extra,
  }
}

/** Stage one: approval to fund the session key, then the blobs, then the refund. */
export async function runStore(connection: Connection, wallet: Signer, s: DropState, hooks: Hooks) {
  const owner = new PublicKey(s.owner)
  const session = Keypair.fromSecretKey(bs58.decode(s.session))
  const bytes = b64.decode(s.image.b64)
  const report = (extra: Partial<Progress> = {}) => hooks.onProgress(progressOf(s, extra))
  const rents = await fetchRents(connection)
  const est = estimate(rents, s.form, bytes.length, s.image.mime, s.pieces.length)

  // 1. fund the session key (skipped when a previous run already left enough on it)
  const balance = BigInt(await connection.getBalance(session.publicKey, 'confirmed'))
  const remaining = remainingStoreLamports(s, est.session, rents, bytes.length)
  if (balance < remaining) {
    const lamports = remaining - balance
    report({ prompt: `Store picture, ${(Number(lamports) / 1e9).toFixed(2)} COOK` })
    const bh = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: owner, recentBlockhash: bh.blockhash }).add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: session.publicKey, lamports }),
    )
    let signed: Transaction
    try {
      signed = await wallet.signTransaction(tx)
    } catch (e) {
      throw new Error(explainError(e))
    }
    report({ prompt: undefined, note: 'Funding the storing key' })
    s.funded = await sendSigned(connection, signed, bh)
    saveDrop(s)
  }
  report()

  // 2. the picture, then the labels
  const save = () => saveDrop(s)
  await uploadBlob({ connection, uploader: session, bytes, mime: s.image.mime, owner, state: s.imageBlob, save, onProgress: () => report() })
  report()
  const labelTasks = [
    () => uploadBlob({ connection, uploader: session, bytes: new TextEncoder().encode(pieceJson(s.form, null, s.imageBlob.pubkey, s.image.mime)), mime: 'application/json', owner, state: s.collectionBlob, save }),
    ...s.pieceBlobs.map((st, i) => () => uploadBlob({ connection, uploader: session, bytes: new TextEncoder().encode(pieceJson(s.form, i + 1, s.imageBlob.pubkey, s.image.mime)), mime: 'application/json', owner, state: st, save })),
  ]
  await pool(8, labelTasks.map((t) => async () => { await t(); report() }))

  // 3. give back what is left
  if (!s.refunded) {
    const left = BigInt(await connection.getBalance(session.publicKey, 'confirmed'))
    if (left > 5000n) {
      const bh = await connection.getLatestBlockhash('confirmed')
      const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: bh.blockhash }).add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: owner, lamports: left - 5000n }))
      tx.sign(session)
      try {
        await sendSigned(connection, tx, bh)
      } catch {
        // a stuck refund is pocket change; the drop goes on
      }
    }
    s.refunded = true
  }
  s.stage = 'mint'
  saveDrop(s)
  report()
}

function remainingStoreLamports(s: DropState, full: bigint, rents: Awaited<ReturnType<typeof fetchRents>>, imageSize: number): bigint {
  // nothing landed yet: the full estimate; otherwise only blobs still to create plus fees for the rest
  if (!s.imageBlob.created && !s.collectionBlob.created) return full
  let need = 10_000_000n
  if (!s.imageBlob.created) need += rents.blobBase + rents.blobPerByte * BigInt(imageSize)
  const label = rents.blobBase + rents.blobPerByte * 400n
  need += label * BigInt([s.collectionBlob, ...s.pieceBlobs].filter((b) => !b.created).length)
  need += 5000n * BigInt(Math.ceil(imageSize / 1000) + s.pieceBlobs.length + 4)
  return need
}

function pieceTx(s: DropState, i: number | null, owner: PublicKey, rents: { mint: bigint }, blockhash: string): { tx: Transaction; mintKp: Keypair } {
  const piece = i === null ? s.collection : s.pieces[i]
  const mintKp = Keypair.fromSecretKey(bs58.decode(piece.secret))
  const mint = mintKp.publicKey
  const recipient = i === null ? owner : new PublicKey(s.recipients[i])
  const ata = getAssociatedTokenAddressSync(mint, recipient)
  const uri = blobUrl(i === null ? s.collectionBlob.pubkey : s.pieceBlobs[i].pubkey)
  const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: i === null ? COLLECTION_UNITS : PIECE_UNITS }),
    SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: mint, lamports: Number(rents.mint), space: MINT_SIZE, programId: TOKEN_PROGRAM }),
    createInitializeMint2Instruction(mint, 0, owner, owner),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, recipient, mint),
    createMintToInstruction(mint, ata, owner, 1),
    createMetadataV3Ix({
      mint,
      authority: owner,
      name: i === null ? s.form.name.trim() : pieceName(s.form.name, i + 1),
      symbol: s.form.symbol,
      uri,
      sellerFeeBps: s.form.royaltyBps,
      creators: [{ address: owner, verified: true, share: 100 }],
      collection: i === null ? undefined : new PublicKey(s.collection.mint),
      isMutable: true,
    }),
    createMasterEditionV3Ix(mint, owner),
  )
  if (i !== null) tx.add(verifyCollectionIx(mint, new PublicKey(s.collection.mint), owner))
  return { tx, mintKp }
}

/** Stage two: the wallet signs the collection and every piece, in groups; pieces are sent in parallel. */
export async function runMint(connection: Connection, wallet: Signer, s: DropState, hooks: Hooks) {
  const owner = new PublicKey(s.owner)
  const report = (extra: Partial<Progress> = {}) => hooks.onProgress(progressOf(s, extra))
  const rents = await fetchRents(connection)

  // anything that landed in an earlier run counts as done
  const unknown = [s.collection, ...s.pieces].filter((p) => !p.done)
  for (let i = 0; i < unknown.length; i += 100) {
    const slice = unknown.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map((p) => new PublicKey(p.mint)), 'confirmed')
    infos.forEach((info, j) => { if (info) slice[j].done = true })
  }
  saveDrop(s)
  report()

  const todo = () => [null, ...s.pieces.map((_, i) => i)].filter((i) => !(i === null ? s.collection : s.pieces[i]).done)
  let round = 0
  while (todo().length) {
    if (++round > 4) throw new Error('Some pieces kept failing. Check your COOK balance and resume.')
    const pending = todo()
    const groups = Math.ceil(pending.length / PIECES_PER_APPROVAL)
    for (let g = 0; g < groups; g++) {
      const group = pending.slice(g * PIECES_PER_APPROVAL, (g + 1) * PIECES_PER_APPROVAL)
      const bh = await connection.getLatestBlockhash('confirmed')
      const built = group.map((i) => ({ i, ...pieceTx(s, i, owner, rents, bh.blockhash) }))
      const n = group.filter((i) => i !== null).length
      report({ prompt: `Mint ${n} piece${n === 1 ? '' : 's'}${groups > 1 ? ` (approval ${g + 1} of ${groups})` : ''}` })
      let signed: Transaction[]
      try {
        signed = wallet.signAllTransactions ? await wallet.signAllTransactions(built.map((b) => b.tx)) : await sequential(wallet, built.map((b) => b.tx))
      } catch (e) {
        throw new Error(explainError(e))
      }
      report({ prompt: undefined })
      signed.forEach((tx, k) => tx.partialSign(built[k].mintKp))
      // the collection must exist before any piece can be verified into it
      const first = built.findIndex((b) => b.i === null)
      if (first >= 0) {
        try {
          s.collection.sig = await sendSigned(connection, signed[first], bh)
          s.collection.done = true
          saveDrop(s)
        } catch (e) {
          report({ note: `Collection didn't land, retrying: ${explainError(e)}` })
          continue
        }
        report()
      }
      await pool(8, built.map((b, k) => async () => {
        if (b.i === null) return
        const piece = s.pieces[b.i]
        try {
          piece.sig = await sendSigned(connection, signed[k], bh)
          piece.done = true
          saveDrop(s)
          report()
        } catch (e) {
          report({ note: `Piece ${b.i + 1} didn't land, sending again: ${explainError(e)}` })
        }
      }))
    }
  }
  s.stage = 'done'
  saveDrop(s)
  report()
}

async function sequential(wallet: Signer, txs: Transaction[]): Promise<Transaction[]> {
  const out: Transaction[] = []
  for (const tx of txs) out.push(await wallet.signTransaction(tx))
  return out
}

/** The whole thing, resumable from whatever stage the state is in. */
export async function runDrop(connection: Connection, wallet: Signer, s: DropState, hooks: Hooks) {
  if (s.stage === 'store') await runStore(connection, wallet, s, hooks)
  if (s.stage === 'mint') await runMint(connection, wallet, s, hooks)
}

export const blockhashes = blockhashCache
