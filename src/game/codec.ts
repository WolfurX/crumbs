import { Buffer } from 'buffer'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'

/** Sequential reader for Anchor/borsh account data, on a DataView so it types the same in Node and browsers. */
export class Reader {
  o = 0
  v: DataView
  bytes: Uint8Array
  constructor(data: Uint8Array) {
    this.bytes = data
    this.v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }
  skip(n: number) { this.o += n }
  u8() { return this.v.getUint8(this.o++) }
  bool() { return this.u8() === 1 }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x }
  u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x }
  i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x }
  u128() { const lo = this.v.getBigUint64(this.o, true); const hi = this.v.getBigUint64(this.o + 8, true); this.o += 16; return (hi << 64n) | lo }
  pubkey() { const k = new PublicKey(this.bytes.subarray(this.o, this.o + 32)); this.o += 32; return k }
  str() { const n = this.v.getUint32(this.o, true); this.o += 4; const t = new TextDecoder().decode(this.bytes.subarray(this.o, this.o + n)); this.o += n; return t }
}

export const enc = {
  u8: (n: number) => Uint8Array.of(n & 0xff),
  u16: (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b },
  u64: (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b },
}

export interface GameState { admin: PublicKey; emission: PublicKey; crumbMint: PublicKey; startFeeLamports: bigint; treasury: PublicKey; freeSlots: bigint; entryBurnBase: bigint; clickCapPerDay: number; poolCookieBps: number; players: bigint; totalClicks: bigint; totalCookiesMilli: bigint }
export interface PlayerState { owner: PublicKey; session: PublicKey; cookiesMilli: bigint; cpsMilli: bigint; owned: number[]; lifetimeCookiesMilli: bigint; lifetimeClicks: bigint; lastTs: bigint; lastClickTs: bigint; clicksThisSec: number; clickDay: bigint; clicksToday: number; pendingDay: bigint; pendingCookiesMilli: bigint; pendingClicks: bigint; claimable: bigint; claimed: bigint }
export interface DayState { day: bigint; cookiesMilli: bigint; clicks: bigint; pool: bigint }
export interface EmissionState { authority: PublicKey; mint: PublicKey; maxSupply: bigint; baseDailyPool: bigint; minted: bigint; totalWeightBps: number; distributors: number }
export interface DistributorState { emission: PublicKey; signer: PublicKey; weightBps: number; enabled: boolean; minted: bigint; name: string }

export function decodeGame(data: Uint8Array): GameState {
  const r = new Reader(data); r.skip(8)
  return { admin: r.pubkey(), emission: r.pubkey(), crumbMint: r.pubkey(), startFeeLamports: r.u64(), treasury: r.pubkey(), freeSlots: r.u64(), entryBurnBase: r.u64(), clickCapPerDay: r.u16(), poolCookieBps: r.u16(), players: r.u64(), totalClicks: r.u64(), totalCookiesMilli: r.u128() }
}
export function decodePlayer(data: Uint8Array): PlayerState {
  const r = new Reader(data); r.skip(8)
  const owner = r.pubkey(), session = r.pubkey(), cookiesMilli = r.u64(), cpsMilli = r.u64()
  const owned: number[] = []
  for (let i = 0; i < 8; i++) owned.push(r.u16())
  return { owner, session, cookiesMilli, cpsMilli, owned, lifetimeCookiesMilli: r.u128(), lifetimeClicks: r.u64(), lastTs: r.i64(), lastClickTs: r.i64(), clicksThisSec: r.u8(), clickDay: r.u64(), clicksToday: r.u16(), pendingDay: r.u64(), pendingCookiesMilli: r.u128(), pendingClicks: r.u64(), claimable: r.u64(), claimed: r.u64() }
}
export function decodeDay(data: Uint8Array): DayState {
  const r = new Reader(data); r.skip(8)
  return { day: r.u64(), cookiesMilli: r.u128(), clicks: r.u64(), pool: r.u64() }
}
export function decodeEmission(data: Uint8Array): EmissionState {
  const r = new Reader(data); r.skip(8)
  return { authority: r.pubkey(), mint: r.pubkey(), maxSupply: r.u64(), baseDailyPool: r.u64(), minted: r.u64(), totalWeightBps: r.u16(), distributors: r.u16() }
}
export function decodeDistributor(data: Uint8Array): DistributorState {
  const r = new Reader(data); r.skip(8)
  return { emission: r.pubkey(), signer: r.pubkey(), weightBps: r.u16(), enabled: r.bool(), minted: r.u64(), name: r.str() }
}

/** Halvings so far and today's pool, mirroring Emission::tranche / pool_now. */
export function emissionMath(e: EmissionState) {
  const remaining = e.maxSupply > e.minted ? e.maxSupply - e.minted : 0n
  let k = 0
  if (remaining === 0n) k = 64
  else while (k < 63 && remaining <= e.maxSupply >> BigInt(k + 1)) k++
  const pool = k >= 64 ? 0n : (e.baseDailyPool >> BigInt(k)) < remaining ? e.baseDailyPool >> BigInt(k) : remaining
  const nextHalvingAt = k >= 64 ? e.maxSupply : e.maxSupply - (e.maxSupply >> BigInt(k + 1))
  return { tranche: k, poolNow: pool, remaining, nextHalvingAt }
}

interface IdlAccount { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string }
interface IdlIx { name: string; discriminator: number[]; accounts: IdlAccount[] }
interface Idl { address: string; instructions: IdlIx[] }

/** Build an instruction from the IDL's account order; pass pubkeys by account name, omit optionals to send the program id. */
export function buildIx(idl: Idl, name: string, args: Uint8Array[], keys: Record<string, PublicKey | undefined>): TransactionInstruction {
  const ix = idl.instructions.find((i) => i.name === name)
  if (!ix) throw new Error(`no instruction ${name}`)
  const programId = new PublicKey(idl.address)
  const metas = ix.accounts.map((a) => {
    const k = keys[a.name] ?? (a.address ? new PublicKey(a.address) : undefined)
    if (!k) {
      if (a.optional) return { pubkey: programId, isSigner: false, isWritable: false }
      throw new Error(`missing account ${a.name} for ${name}`)
    }
    return { pubkey: k, isSigner: !!a.signer, isWritable: !!a.writable }
  })
  return new TransactionInstruction({ programId, keys: metas, data: Buffer.concat([Buffer.from(ix.discriminator), ...args.map((a) => Buffer.from(a))]) })
}
