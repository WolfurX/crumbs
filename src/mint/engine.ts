// A quick drop, run by a throwaway session key so the wallet approves exactly once: the transfer
// that funds the key. The key then streams the picture and one metadata JSON per piece into
// crumb_store blobs, mints the collection NFT, mints and verifies every piece, hands every update
// authority to the creator, and refunds what is left. Every step is idempotent against the saved
// state, so a killed tab resumes without minting twice or re-sending chunks that landed.
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js'
import { MINT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { TOKEN_PROGRAM } from '../lib/chain'
import { explainError, type Signer } from '../lib/txs'
import { blobUrl, blockhashCache, newUploadState, pool, sendSigned, uploadBlob, type UploadState } from './blob'
import { createMasterEditionV3Ix, createMetadataV3Ix, setUpdateAuthorityIx, verifyCollectionIx } from './tm'
import { blobRentOf, estimate, fetchRents, pieceJson, pieceName, type DropForm, type Rents } from './plan'

export type Stage = 'store' | 'mint' | 'done'

export interface PieceState { mint: string; secret: string; done: boolean; sig?: string }

export interface DropState {
  v: 2
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
  /** The collection's update authority went to the creator (after every piece was verified). */
  handedOver?: boolean
  refunded?: boolean
}

const key = (owner: PublicKey | string) => `crumbs.drop.${typeof owner === 'string' ? owner : owner.toBase58()}`

export function loadDrop(owner: PublicKey): DropState | null {
  try {
    const raw = localStorage.getItem(key(owner))
    const s = raw ? (JSON.parse(raw) as DropState) : null
    return s && s.v === 2 ? s : null
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
    v: 2,
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
  chunksDone: number
  chunksTotal: number
  labelsDone: number
  labelsTotal: number
  /** Pieces only; the collection is not counted. */
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

const COLLECTION_UNITS = 220_000
const PIECE_UNITS = 300_000
const FEE = 5000n

function progressOf(s: DropState, extra: Partial<Progress> = {}): Progress {
  const imageSize = Math.ceil((s.image.b64.length * 3) / 4)
  const chunksTotal = imageSize <= 700 ? 1 : Math.ceil(imageSize / 1000)
  return {
    stage: s.stage,
    chunksDone: s.imageBlob.finalized ? chunksTotal : s.imageBlob.chunks.length,
    chunksTotal,
    labelsDone: (s.collectionBlob.finalized ? 1 : 0) + s.pieceBlobs.filter((b) => b.finalized).length,
    labelsTotal: s.pieceBlobs.length + 1,
    piecesDone: s.pieces.filter((p) => p.done).length,
    piecesTotal: s.pieces.length,
    ...extra,
  }
}

/** What the session key still needs for everything that has not landed yet. */
function remainingLamports(s: DropState, rents: Rents, imageSize: number): bigint {
  const labelSize = 450
  let need = 10_000_000n
  if (!s.imageBlob.created) need += blobRentOf(rents, imageSize) + FEE * BigInt(2 + Math.ceil(imageSize / 1000))
  else need += FEE * BigInt(1 + Math.ceil(imageSize / 1000) - s.imageBlob.chunks.length)
  need += (blobRentOf(rents, labelSize) + FEE) * BigInt([s.collectionBlob, ...s.pieceBlobs].filter((b) => !b.created).length)
  const per = rents.mint + rents.ata + rents.metadata + rents.edition + FEE
  need += per * BigInt([s.collection, ...s.pieces].filter((p) => !p.done).length)
  need += FEE * 2n
  return need
}

function mintTx(s: DropState, i: number | null, session: Keypair, creator: PublicKey, rents: Rents, blockhash: string): { tx: Transaction; mintKp: Keypair } {
  const piece = i === null ? s.collection : s.pieces[i]
  const mintKp = Keypair.fromSecretKey(bs58.decode(piece.secret))
  const mint = mintKp.publicKey
  const recipient = i === null ? creator : new PublicKey(s.recipients[i])
  const ata = getAssociatedTokenAddressSync(mint, recipient)
  const uri = blobUrl(i === null ? s.collectionBlob.pubkey : s.pieceBlobs[i].pubkey)
  const me = session.publicKey
  const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: i === null ? COLLECTION_UNITS : PIECE_UNITS }),
    SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: mint, lamports: Number(rents.mint), space: MINT_SIZE, programId: TOKEN_PROGRAM }),
    createInitializeMint2Instruction(mint, 0, me, me),
    createAssociatedTokenAccountIdempotentInstruction(me, ata, recipient, mint),
    createMintToInstruction(mint, ata, me, 1),
    createMetadataV3Ix({
      mint,
      authority: me,
      name: i === null ? s.form.name.trim() : pieceName(s.form.name, i + 1),
      symbol: s.form.symbol,
      uri,
      sellerFeeBps: s.form.royaltyBps,
      creators: [{ address: creator, verified: false, share: 100 }],
      collection: i === null ? undefined : new PublicKey(s.collection.mint),
      isMutable: true,
    }),
    createMasterEditionV3Ix(mint, me),
  )
  // pieces: verified into the collection (the session is its update authority for now), then handed over
  if (i !== null) tx.add(verifyCollectionIx(mint, new PublicKey(s.collection.mint), me), setUpdateAuthorityIx(mint, me, creator))
  return { tx, mintKp }
}

/** The whole drop, resumable from whatever the saved state says already happened. */
export async function runDrop(connection: Connection, wallet: Signer, s: DropState, hooks: Hooks) {
  const creator = new PublicKey(s.owner)
  const session = Keypair.fromSecretKey(bs58.decode(s.session))
  const me = session.publicKey
  const bytes = b64.decode(s.image.b64)
  const report = (extra: Partial<Progress> = {}) => hooks.onProgress(progressOf(s, extra))
  const rents = await fetchRents(connection)
  const save = () => saveDrop(s)
  const nextBlockhash = blockhashCache(connection)

  // anything that landed in an earlier run counts as done
  const unknown = [s.collection, ...s.pieces].filter((p) => !p.done)
  for (let i = 0; i < unknown.length; i += 100) {
    const slice = unknown.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map((p) => new PublicKey(p.mint)), 'confirmed')
    infos.forEach((info, j) => { if (info) slice[j].done = true })
  }
  save()

  // 1. the one wallet approval: fund the session key
  const balance = BigInt(await connection.getBalance(me, 'confirmed'))
  const need = s.funded ? remainingLamports(s, rents, bytes.length) : estimate(rents, s.form, bytes.length, s.image.mime, s.pieces.length).session
  if (balance < need) {
    const lamports = need - balance
    report({ prompt: `Fund the drop, ${(Number(lamports) / 1e9).toFixed(2)} COOK` })
    const bh = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: creator, recentBlockhash: bh.blockhash }).add(SystemProgram.transfer({ fromPubkey: creator, toPubkey: me, lamports }))
    let signed: Transaction
    try {
      signed = await wallet.signTransaction(tx)
    } catch (e) {
      throw new Error(explainError(e))
    }
    report({ prompt: undefined, note: 'Funding the drop' })
    s.funded = await sendSigned(connection, signed, bh)
    save()
  }
  report({ prompt: undefined })

  // 2. the picture, then the labels
  if (s.stage === 'store') {
    await uploadBlob({ connection, uploader: session, bytes, mime: s.image.mime, owner: creator, state: s.imageBlob, save, onProgress: () => report() })
    report()
    const labels = [
      () => uploadBlob({ connection, uploader: session, bytes: new TextEncoder().encode(pieceJson(s.form, null, s.imageBlob.pubkey, s.image.mime)), mime: 'application/json', owner: creator, state: s.collectionBlob, save }),
      ...s.pieceBlobs.map((st, i) => () => uploadBlob({ connection, uploader: session, bytes: new TextEncoder().encode(pieceJson(s.form, i + 1, s.imageBlob.pubkey, s.image.mime)), mime: 'application/json', owner: creator, state: st, save })),
    ]
    await pool(8, labels.map((t) => async () => { await t(); report() }))
    s.stage = 'mint'
    save()
    report()
  }

  // 3. the collection, then the pieces in parallel, then the collection handover
  if (s.stage === 'mint') {
    const sendPiece = async (i: number | null) => {
      const piece = i === null ? s.collection : s.pieces[i]
      if (piece.done) return
      let last: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          // a retry needs a fresh blockhash: the same bytes would be refused as already processed
          const bh = await nextBlockhash(attempt > 0)
          const { tx, mintKp } = mintTx(s, i, session, creator, rents, bh.blockhash)
          tx.sign(session, mintKp)
          piece.sig = await sendSigned(connection, tx, bh)
          piece.done = true
          save()
          report()
          return
        } catch (e) {
          last = e
          // a mint account that exists means an earlier attempt landed after all
          if (await connection.getAccountInfo(new PublicKey(piece.mint), 'confirmed')) {
            piece.done = true
            save()
            report()
            return
          }
          const logs = ((e as { logs?: string[] }).logs ?? []).filter((l) => /failed|error|Error/i.test(l)).slice(-3).join(' · ')
          report({ note: `${i === null ? 'The collection' : `Piece ${i + 1}`} didn't land, sending again: ${explainError(e)}${logs ? ` [${logs}]` : ''}` })
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
        }
      }
      throw new Error(`${i === null ? 'The collection' : `Piece ${i + 1}`} kept failing: ${explainError(last)}`)
    }
    await sendPiece(null)
    await pool(8, s.pieces.map((_, i) => () => sendPiece(i)))
    if (!s.handedOver) {
      const bh = await nextBlockhash()
      const tx = new Transaction({ feePayer: me, recentBlockhash: bh.blockhash }).add(setUpdateAuthorityIx(new PublicKey(s.collection.mint), me, creator))
      tx.sign(session)
      await sendSigned(connection, tx, bh)
      s.handedOver = true
      save()
    }
    s.stage = 'done'
    save()
  }

  // 4. give back what is left
  if (!s.refunded) {
    const left = BigInt(await connection.getBalance(me, 'confirmed'))
    if (left > FEE) {
      try {
        const bh = await connection.getLatestBlockhash('confirmed')
        const tx = new Transaction({ feePayer: me, recentBlockhash: bh.blockhash }).add(SystemProgram.transfer({ fromPubkey: me, toPubkey: creator, lamports: left - FEE }))
        tx.sign(session)
        await sendSigned(connection, tx, bh)
      } catch {
        // a stuck refund is pocket change; the drop is done either way
      }
    }
    s.refunded = true
    save()
  }
  report()
}

/** Send back whatever a discarded drop left on its session key. */
export async function refundDrop(connection: Connection, s: DropState): Promise<bigint> {
  const session = Keypair.fromSecretKey(bs58.decode(s.session))
  const left = BigInt(await connection.getBalance(session.publicKey, 'confirmed'))
  if (left <= FEE) return 0n
  const bh = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: bh.blockhash }).add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: new PublicKey(s.owner), lamports: left - FEE }))
  tx.sign(session)
  await sendSigned(connection, tx, bh)
  return left - FEE
}
