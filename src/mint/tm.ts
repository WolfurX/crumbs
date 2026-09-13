// Hand-encoded Metaplex Token Metadata instructions, same approach as program/scripts/init-mainnet.mjs.
// Only what a quick drop needs: metadata v3, master edition v3, collection verify.
import { Buffer } from 'buffer'
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { TOKEN_PROGRAM } from '../lib/chain'

export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

/** On-chain field limits of Token Metadata. */
export const NAME_MAX = 32
export const SYMBOL_MAX = 10
export const URI_MAX = 200

export const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0]
export const editionPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer(), Buffer.from('edition')], METADATA_PROGRAM)[0]

const u8 = (n: number) => Buffer.from([n & 0xff])
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return Buffer.from(b) }
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return Buffer.from(b) }
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return Buffer.from(b) }
const bool = (v: boolean) => Buffer.from([v ? 1 : 0])
const str = (s: string) => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u32(d.length), d]) }
const none = () => Buffer.from([0])
const some = (b: Buffer) => Buffer.concat([Buffer.from([1]), b])
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })

export interface Creator { address: PublicKey; verified: boolean; share: number }

export interface MetadataArgs {
  mint: PublicKey
  /** Signs; also the payer and update authority. */
  authority: PublicKey
  name: string
  symbol: string
  uri: string
  sellerFeeBps: number
  creators: Creator[]
  /** Unverified collection pointer; verified afterwards with verifyCollectionIx. */
  collection?: PublicKey
  isMutable: boolean
}

/** CreateMetadataAccountV3 (discriminator 33). */
export function createMetadataV3Ix(a: MetadataArgs): TransactionInstruction {
  if (Buffer.byteLength(a.name) > NAME_MAX || Buffer.byteLength(a.symbol) > SYMBOL_MAX || Buffer.byteLength(a.uri) > URI_MAX) throw new Error('metadata field too long')
  const creators = a.creators.length
    ? some(Buffer.concat([u32(a.creators.length), ...a.creators.map((c) => Buffer.concat([c.address.toBuffer(), bool(c.verified), u8(c.share)]))]))
    : none()
  const collection = a.collection ? some(Buffer.concat([bool(false), a.collection.toBuffer()])) : none()
  const data = Buffer.concat([u8(33), str(a.name), str(a.symbol), str(a.uri), u16(a.sellerFeeBps), creators, collection, none(), bool(a.isMutable), none()])
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    data,
    keys: [
      meta(metadataPda(a.mint), true),
      meta(a.mint),
      meta(a.authority, false, true), // mint authority
      meta(a.authority, true, true), // payer
      meta(a.authority, false, true), // update authority
      meta(SystemProgram.programId),
      meta(SYSVAR_RENT_PUBKEY),
    ],
  })
}

/** CreateMasterEditionV3 (discriminator 17), max supply 0: a one-of-one, no prints. */
export function createMasterEditionV3Ix(mint: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    data: Buffer.concat([u8(17), some(u64(0n))]),
    keys: [
      meta(editionPda(mint), true),
      meta(mint, true),
      meta(authority, false, true), // update authority
      meta(authority, false, true), // mint authority
      meta(authority, true, true), // payer
      meta(metadataPda(mint), true),
      meta(TOKEN_PROGRAM),
      meta(SystemProgram.programId),
      meta(SYSVAR_RENT_PUBKEY),
    ],
  })
}

/** Verify (discriminator 52) with VerificationArgs::CollectionV1; the collection's update authority signs. */
export function verifyCollectionIx(itemMint: PublicKey, collectionMint: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    data: Buffer.concat([u8(52), u8(1)]),
    keys: [
      meta(authority, false, true),
      meta(METADATA_PROGRAM), // delegate record: none
      meta(metadataPda(itemMint), true),
      meta(collectionMint),
      meta(metadataPda(collectionMint), true),
      meta(editionPda(collectionMint)),
      meta(SystemProgram.programId),
      meta(SYSVAR_INSTRUCTIONS_PUBKEY),
    ],
  })
}

/** VerifyCollection (discriminator 18), the older instruction, kept as a fallback for the live test. */
export function verifyCollectionLegacyIx(itemMint: PublicKey, collectionMint: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    data: u8(18),
    keys: [
      meta(metadataPda(itemMint), true),
      meta(authority, true, true),
      meta(authority, true, true),
      meta(collectionMint),
      meta(metadataPda(collectionMint)),
      meta(editionPda(collectionMint)),
    ],
  })
}
