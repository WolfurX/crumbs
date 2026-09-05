import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CLICKER_PROGRAM, CRUMB_MINT, DISTRIBUTOR_PDA, EMISSION_PDA, EMISSION_PROGRAM, GAME_PDA, MINTER_PDA, clickerIdl, dayIndex, dayPda, playerPda } from './constants'
import { buildIx, decodeDay, decodeDistributor, decodeEmission, decodeGame, decodePlayer, enc, type DayState, type DistributorState, type EmissionState, type GameState, type PlayerState } from './codec'

export const CLICKER_ERRORS: Record<number, string> = {
  6000: 'That key may not act for this player.',
  6001: 'Too fast: three clicks per second.',
  6002: 'Daily click cap reached. Come back tomorrow.',
  6003: 'Not enough cookies.',
  6004: 'Unknown tier.',
  6005: 'Count must be 1 to 20.',
  6006: 'The day rolled over. Refreshing.',
  6007: 'Yesterday needs settling first.',
  6008: 'Nothing to claim yet.',
  6009: 'The day is not over.',
  6010: 'Arithmetic overflow.',
  6011: 'Bad configuration.',
}

export function explainGameError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const logs = (e as { logs?: string[] })?.logs?.join(' ') ?? ''
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(msg + ' ' + logs) ?? /"Custom":\s*(\d+)/.exec(msg + ' ' + logs)
  if (m) {
    const code = m[0].includes('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10)
    if (CLICKER_ERRORS[code]) return CLICKER_ERRORS[code]
  }
  if (/insufficient lamports|insufficient funds/i.test(msg + logs)) return 'The session wallet is out of COOK. Top it up.'
  if (/Blockhash not found|block height exceeded/i.test(msg)) return 'Transaction expired, try again.'
  return msg.length > 140 ? msg.slice(0, 137) + '…' : msg
}

export class GameClient {
  connection: Connection
  constructor(connection: Connection) {
    this.connection = connection
  }

  async fetchGame(): Promise<GameState> {
    const a = await this.connection.getAccountInfo(GAME_PDA)
    if (!a) throw new Error('game not initialised')
    return decodeGame(a.data)
  }
  async fetchEmission(): Promise<EmissionState> {
    const a = await this.connection.getAccountInfo(EMISSION_PDA)
    if (!a) throw new Error('emission not initialised')
    return decodeEmission(a.data)
  }
  async fetchDistributor(): Promise<DistributorState> {
    const a = await this.connection.getAccountInfo(DISTRIBUTOR_PDA)
    if (!a) throw new Error('distributor missing')
    return decodeDistributor(a.data)
  }
  async fetchPlayer(owner: PublicKey): Promise<PlayerState | null> {
    const a = await this.connection.getAccountInfo(playerPda(owner))
    return a ? decodePlayer(a.data) : null
  }
  async fetchDay(day: bigint): Promise<DayState | null> {
    const a = await this.connection.getAccountInfo(dayPda(day))
    return a ? decodeDay(a.data) : null
  }
  async fetchCrumbBalance(owner: PublicKey): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(CRUMB_MINT, owner)
    const b = await this.connection.getTokenAccountBalance(ata).catch(() => null)
    return b ? BigInt(b.value.amount) : 0n
  }

  /** Every player, sorted by lifetime cookies. One getProgramAccounts call. */
  async leaderboard(limit = 50): Promise<PlayerState[]> {
    const disc = clickerIdl.accounts.find((a) => a.name === 'Player')!.discriminator
    const accounts = await this.connection.getProgramAccounts(CLICKER_PROGRAM, {
      filters: [{ memcmp: { offset: 0, bytes: bs58encode(Uint8Array.from(disc)) } }],
    })
    return accounts
      .map((a) => decodePlayer(new Uint8Array(a.account.data)))
      .sort((x, y) => (y.lifetimeCookiesMilli > x.lifetimeCookiesMilli ? 1 : y.lifetimeCookiesMilli < x.lifetimeCookiesMilli ? -1 : 0))
      .slice(0, limit)
  }

  // --- transactions signed by the owner's wallet ---------------------------------------------

  /** Create the player account. `entryBurn` > 0 means the owner's CRUMB account is needed. */
  startIx(owner: PublicKey, session: PublicKey, game: GameState, entryBurn: bigint): TransactionInstruction {
    return buildIx(clickerIdl, 'start', [session.toBytes()], {
      owner, game: GAME_PDA, player: playerPda(owner), treasury: game.treasury, crumb_mint: CRUMB_MINT,
      owner_crumb: entryBurn > 0n ? getAssociatedTokenAddressSync(CRUMB_MINT, owner) : undefined,
      token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
    })
  }
  topUpIx(owner: PublicKey, session: PublicKey, lamports: number): TransactionInstruction {
    return SystemProgram.transfer({ fromPubkey: owner, toPubkey: session, lamports })
  }
  setSessionIx(owner: PublicKey, session: PublicKey): TransactionInstruction {
    return buildIx(clickerIdl, 'set_session', [session.toBytes()], { owner, player: playerPda(owner) })
  }

  // --- transactions signed by the session key -------------------------------------------------

  private actKeys(authority: PublicKey, owner: PublicKey, player: PlayerState, now: number) {
    const today = dayIndex(now)
    const needsPrev = player.pendingDay !== today && (player.pendingCookiesMilli > 0n || player.pendingClicks > 0n)
    return {
      day: today,
      keys: {
        authority, game: GAME_PDA, player: playerPda(owner), today: dayPda(today),
        prev_day: needsPrev ? dayPda(player.pendingDay) : undefined,
        emission: EMISSION_PDA, distributor: DISTRIBUTOR_PDA, system_program: SystemProgram.programId,
      },
    }
  }
  clickIx(session: PublicKey, owner: PublicKey, player: PlayerState, now = Date.now() / 1000) {
    const { day, keys } = this.actKeys(session, owner, player, now)
    return buildIx(clickerIdl, 'click', [enc.u64(day)], keys)
  }
  buyIx(session: PublicKey, owner: PublicKey, player: PlayerState, tier: number, count: number, now = Date.now() / 1000) {
    const { day, keys } = this.actKeys(session, owner, player, now)
    return buildIx(clickerIdl, 'buy', [enc.u64(day), enc.u8(tier), enc.u8(count)], keys)
  }
  settleIx(session: PublicKey, owner: PublicKey, player: PlayerState, now = Date.now() / 1000) {
    const { day, keys } = this.actKeys(session, owner, player, now)
    return buildIx(clickerIdl, 'settle', [enc.u64(day)], keys)
  }
  claimIx(session: PublicKey, owner: PublicKey, player: PlayerState, now = Date.now() / 1000) {
    const { day, keys } = this.actKeys(session, owner, player, now)
    return buildIx(clickerIdl, 'claim', [enc.u64(day)], {
      ...keys, owner, minter: MINTER_PDA, crumb_mint: CRUMB_MINT, owner_crumb: getAssociatedTokenAddressSync(CRUMB_MINT, owner),
      emission_program: EMISSION_PROGRAM, token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
  }
  withdrawIx(session: PublicKey, owner: PublicKey, lamports: number) {
    return SystemProgram.transfer({ fromPubkey: session, toPubkey: owner, lamports })
  }

  /** Sign with the session key and send. Returns the signature without waiting for confirmation. */
  async sendWithSession(session: Keypair, ixs: TransactionInstruction[], skipPreflight = false): Promise<{ signature: string; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: blockhash }).add(...ixs)
    tx.sign(session)
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 2 })
    return { signature, blockhash, lastValidBlockHeight }
  }
  async confirm(sig: { signature: string; blockhash: string; lastValidBlockHeight: number }) {
    const r = await this.connection.confirmTransaction(sig, 'confirmed')
    if (r.value.err) throw Object.assign(new Error(`On-chain error ${JSON.stringify(r.value.err)}`), { err: r.value.err })
  }
}

// tiny base58 for the memcmp filter (web3.js does not export one)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break }
  return s
}
