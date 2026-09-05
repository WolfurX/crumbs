// One-time initialisation on Cookie Chain: create the CRUMB mint + metadata, hand the mint to the
// emission program, register the clicker as the only distributor, create the game.
// Idempotent-ish: skips steps whose accounts already exist. Run: node scripts/init-mainnet.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction, getMinimumBalanceForRentExemptMint, getMint } from '@solana/spl-token'
import { loadIdl, ix, meta, u64, u16, bool, str, u8, optionNone, pubkey } from './anchor-lite.mjs'

const RPC = 'https://rpc.cookiescan.io'
const conn = new Connection(RPC, 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const emissionIdl = loadIdl(new URL('../target/idl/crumb_emission.json', import.meta.url).pathname)
const clickerIdl = loadIdl(new URL('../target/idl/crumb_clicker.json', import.meta.url).pathname)
const EMISSION = new PublicKey(emissionIdl.address)
const CLICKER = new PublicKey(clickerIdl.address)
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

const CRUMB = 1_000_000n
const MAX_SUPPLY = 100_000_000n * CRUMB
const BASE_POOL = 100_000n * CRUMB
const START_FEE = 10_000_000 // 0.01 COOK
const FREE_SLOTS = 500
const ENTRY_BURN_BASE = 10n * CRUMB
const CLICK_CAP = 5000
const POOL_COOKIE_BPS = 7000
const TREASURY = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : admin.publicKey

const statePath = new URL('./mainnet.json', import.meta.url).pathname
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))

async function send(label, ixs, signers = []) {
  const tx = new Transaction().add(...ixs)
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = admin.publicKey
  tx.sign(admin, ...signers)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`)
  console.log(`${label}: ${sig}`)
  return sig
}

const [emissionPda] = PublicKey.findProgramAddressSync([Buffer.from('emission')], EMISSION)
const [gamePda] = PublicKey.findProgramAddressSync([Buffer.from('game')], CLICKER)
const [minterPda] = PublicKey.findProgramAddressSync([Buffer.from('minter')], CLICKER)
const [distributorPda] = PublicKey.findProgramAddressSync([Buffer.from('distributor'), minterPda.toBuffer()], EMISSION)
console.log('admin', admin.publicKey.toBase58(), 'balance', (await conn.getBalance(admin.publicKey)) / 1e9, 'COOK')
console.log('emission PDA', emissionPda.toBase58(), '| game PDA', gamePda.toBase58(), '| minter', minterPda.toBase58(), '| distributor', distributorPda.toBase58())

// 1. mint + metadata
let mintPk
if (state.mint) {
  mintPk = new PublicKey(state.mint)
  console.log('mint exists', state.mint)
} else {
  const mint = Keypair.generate()
  mintPk = mint.publicKey
  const rent = await getMinimumBalanceForRentExemptMint(conn)
  const [metadataPda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()], METADATA_PROGRAM)
  // CreateMetadataAccountV3: disc 33, DataV2, is_mutable, collection_details(None)
  const data = Buffer.concat([
    u8(33),
    str('Crumb'), str('CRUMB'), str('https://crumbs-cookie.vercel.app/crumb.json'),
    u16(0), optionNone(), optionNone(), optionNone(),
    bool(true), optionNone(),
  ])
  const metaIx = { programId: METADATA_PROGRAM, data, keys: [
    meta(metadataPda, true), meta(mintPk, false), meta(admin.publicKey, false, true), meta(admin.publicKey, true, true), meta(admin.publicKey, false, true), meta(SystemProgram.programId), meta(SYSVAR_RENT_PUBKEY),
  ] }
  await send('create mint + metadata', [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mintPk, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mintPk, 6, admin.publicKey, admin.publicKey),
    metaIx,
  ], [mint])
  state.mint = mintPk.toBase58()
  state.metadata = metadataPda.toBase58()
  save()
}

// 2. emission.initialize
if (!(await conn.getAccountInfo(emissionPda))) {
  await send('emission.initialize', [ix(EMISSION, emissionIdl, 'initialize', [u64(MAX_SUPPLY), u64(BASE_POOL)], [
    meta(admin.publicKey, true, true), meta(emissionPda, true), meta(mintPk, true), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
  ])])
} else console.log('emission already initialised')
const m = await getMint(conn, mintPk)
console.log('mint authority now', m.mintAuthority?.toBase58(), '| freeze', m.freezeAuthority?.toBase58() ?? 'none', '| supply', m.supply.toString())

// 3. register the clicker's minter PDA as the only distributor at 100%
if (!(await conn.getAccountInfo(distributorPda))) {
  await send('emission.set_distributor', [ix(EMISSION, emissionIdl, 'set_distributor', [u16(10000), bool(true), str('clicker')], [
    meta(admin.publicKey, true, true), meta(emissionPda, true), meta(minterPda), meta(distributorPda, true), meta(SystemProgram.programId),
  ])])
} else console.log('distributor exists')

// 4. clicker.init_game
if (!(await conn.getAccountInfo(gamePda))) {
  await send('clicker.init_game', [ix(CLICKER, clickerIdl, 'init_game', [u64(START_FEE), u64(FREE_SLOTS), u64(ENTRY_BURN_BASE), u16(CLICK_CAP), u16(POOL_COOKIE_BPS)], [
    meta(admin.publicKey, true, true), meta(gamePda, true), meta(minterPda), meta(emissionPda), meta(TREASURY), meta(SystemProgram.programId),
  ])])
} else console.log('game exists')

state.emission = emissionPda.toBase58(); state.game = gamePda.toBase58(); state.minter = minterPda.toBase58(); state.distributor = distributorPda.toBase58()
state.emissionProgram = EMISSION.toBase58(); state.clickerProgram = CLICKER.toBase58(); state.treasury = TREASURY.toBase58()
save()
console.log('done', JSON.stringify(state, null, 2))
