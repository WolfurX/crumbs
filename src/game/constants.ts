import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import mainnet from './idl/mainnet.json'
import clickerIdl from './idl/crumb_clicker.json'
import emissionIdl from './idl/crumb_emission.json'

export { clickerIdl, emissionIdl }

export const CLICKER_PROGRAM = new PublicKey(mainnet.clickerProgram)
export const EMISSION_PROGRAM = new PublicKey(mainnet.emissionProgram)
export const CRUMB_MINT = new PublicKey(mainnet.mint)
export const GAME_PDA = new PublicKey(mainnet.game)
export const EMISSION_PDA = new PublicKey(mainnet.emission)
export const MINTER_PDA = new PublicKey(mainnet.minter)
export const DISTRIBUTOR_PDA = new PublicKey(mainnet.distributor)
export const CRUMB_DECIMALS = 6

export const TIERS = 8
export const TIER_NAMES = ['Cursor', 'Grandma', 'Oven', 'Bakery', 'Factory', 'Validator', 'Bridge', 'Cookie Jar']
export const TIER_LINES = [
  'Points and clicks for you, slowly.',
  'Bakes a cookie a second. Never asks for anything.',
  'Eight a second, runs day and night.',
  'A real shopfront on Cookie Chain.',
  'Industrial output, industrial noise.',
  'Bakes blocks. And cookies.',
  'Cookies arrive from Solana, somehow.',
  'The community vault. Bakes at scale.',
]
export const TIER_COST = [120n, 3_000n, 60_000n, 880_000n, 12_000_000n, 160_000_000n, 2_300_000_000n, 32_000_000_000n]
export const TIER_CPS_MILLI = [100n, 1_000n, 8_000n, 47_000n, 260_000n, 1_400_000n, 7_800_000n, 44_000_000n]
export const MILLI = 1_000n
export const MAX_UNITS = 400
export const SECONDS_PER_DAY = 86_400

export function dayIndex(tsSeconds: number): bigint {
  return BigInt(Math.floor(Math.max(0, tsSeconds) / SECONDS_PER_DAY))
}

/** Price of the next unit of a tier, milli-cookies. Mirrors tier_price_milli in the program. */
export function tierPriceMilli(tier: number, owned: number): bigint {
  let p = TIER_COST[tier] * MILLI
  for (let i = 0; i < owned; i++) p = (p * 115n) / 100n
  return p
}

export const playerPda = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('player'), owner.toBuffer()], CLICKER_PROGRAM)[0]
export const dayPda = (day: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, day, true)
  return PublicKey.findProgramAddressSync([Buffer.from('day'), Buffer.from(b)], CLICKER_PROGRAM)[0]
}
