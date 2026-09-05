// Minimal Anchor client for scripts: discriminators from the IDL JSON, borsh by hand.
import { readFileSync } from 'node:fs'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'

export function loadIdl(path) { return JSON.parse(readFileSync(path, 'utf8')) }
export function disc(idl, name) {
  const ix = idl.instructions.find((i) => i.name === name)
  if (!ix) throw new Error('no instruction ' + name)
  return Buffer.from(ix.discriminator)
}
export function accountDisc(idl, name) { return Buffer.from(idl.accounts.find((a) => a.name === name).discriminator) }
export const u8 = (n) => Buffer.from([n & 0xff])
export const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
export const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export const bool = (v) => Buffer.from([v ? 1 : 0])
export const str = (s) => { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]) }
export const pubkey = (k) => new PublicKey(k).toBuffer()
export const optionNone = () => Buffer.from([0])
export function ix(programId, idl, name, args, accounts) {
  // accounts: array of {pubkey, isSigner, isWritable} in IDL order
  return new TransactionInstruction({ programId: new PublicKey(programId), keys: accounts, data: Buffer.concat([disc(idl, name), ...args]) })
}
export const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isWritable, isSigner })
