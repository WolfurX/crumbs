// Live test of the NFT airdrop and creator verification against Cookie Chain with the deployer keypair.
// Mints a 4-piece collection to the deployer through the real mint engine, signs the creator on every
// piece (SignMetadata batches), then airdrops three pieces to the Nightly test wallet and two fresh
// wallets through the real airdrop planner. Expected values come from the chain by other routes: the
// creator flags from an independent byte walk of each metadata account, the owners from
// getTokenLargestAccounts + jsonParsed. Spends about 0.7 COOK. Usage: npx --yes tsx scripts/nft-airdrop-test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { RPC_URL } from '../src/lib/chain'
import { nftAsset, planAirdrop } from '../src/lib/airdrop'
import { fetchWalletNfts } from '../src/lib/nfts'
import { fetchOwnedAccounts } from '../src/lib/revoke'
import { runBatches, type Signer } from '../src/lib/txs'
import { loadDrop, newDrop, runDrop, type Progress } from '../src/mint/engine'
import { metadataPda } from '../src/mint/tm'
import { planCreatorVerify } from '../src/mint/verify'

// Node has no localStorage: the drop state lives in its own file (the older mint-test file stays as it is).
const STATE_FILE = `${process.env.HOME}/.config/crumbs/nft-airdrop-test-state.json`
const mem: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; writeFileSync(STATE_FILE, JSON.stringify(mem)) },
  removeItem: (k: string) => { delete mem[k]; writeFileSync(STATE_FILE, JSON.stringify(mem)) },
}
process.on('unhandledRejection', (e) => { console.error('FAILED', e); process.exit(1) })

const conn = new Connection(RPC_URL, 'confirmed')
const raw = JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))
const kp = Keypair.fromSecretKey(Uint8Array.from(Array.isArray(raw) ? raw : raw.secretKey))
const signer: Signer = {
  publicKey: kp.publicKey,
  signTransaction: async <T extends Transaction>(tx: T) => (tx.partialSign(kp), tx),
  signAllTransactions: async <T extends Transaction>(txs: T[]) => (txs.forEach((t) => t.partialSign(kp)), txs),
}
const NIGHTLY = 'FcxKQjZVoej6AP4aLd9x6BwrSFg8LCZPbjiLdmL9wgJo' // the Nightly test wallet
const OLD_COLLECTION = '7Dh4abHZbo35ktJVs2MmFB26m883W6qxRWKKwAbynQYb' // Crumbs Test Pass from mint-test.ts, its piece #1 is in the deployer wallet
const OLD_PIECE = 'HTg86AL52Uw9uuU8B69UYXv5FPM74EfWkmzGLxeei5Uk'
const cook = (n: bigint | number) => (Number(n) / 1e9).toFixed(4)
let fails = 0
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) fails++ }

/** Independent read of the creators in a metadata account: a byte walk that shares nothing with src/. */
async function creatorFlags(mint: string): Promise<{ address: string; verified: number }[]> {
  const info = await conn.getAccountInfo(metadataPda(new PublicKey(mint)))
  if (!info) return []
  const d = info.data
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  let o = 65
  for (let i = 0; i < 3; i++) o += 4 + v.getUint32(o, true)
  o += 2
  if (d[o++] !== 1) return []
  const n = v.getUint32(o, true)
  o += 4
  const out = []
  for (let i = 0; i < n; i++, o += 34) out.push({ address: new PublicKey(d.subarray(o, o + 32)).toBase58(), verified: d[o + 32] })
  return out
}
/** Who holds a one-of-one, by the RPC's own accounting. */
async function ownerOf(mint: string): Promise<string | null> {
  const largest = (await conn.getTokenLargestAccounts(new PublicKey(mint))).value.find((a) => a.amount === '1')
  if (!largest) return null
  const acc = await conn.getParsedAccountInfo(largest.address)
  if (!acc.value) return null
  return (acc.value.data as { parsed: { info: { owner: string } } }).parsed.info.owner
}

const png = new Uint8Array(readFileSync('public/icon-192.png'))
console.log('deployer', kp.publicKey.toBase58(), 'balance', cook(await conn.getBalance(kp.publicKey)), 'COOK; picture', png.length, 'bytes')

// 1. a 4-piece drop to the deployer (resumable: RESUME=1 picks up a stopped run)
const form = { name: 'Crumbs Drop Test', symbol: 'CDT', description: 'Engine test of the Crumbs NFT airdrop. Safe to ignore.', royaltyBps: 250 }
const state = (process.env.RESUME && loadDrop(kp.publicKey)) || newDrop(kp.publicKey, form, [kp.publicKey, kp.publicKey, kp.publicKey, kp.publicKey], { bytes: png, mime: 'image/png', width: 192, height: 192 })
const t0 = Date.now()
let last = ''
await runDrop(conn, signer, state, {
  onProgress: (p: Progress) => {
    const line = `${p.stage} chunks ${p.chunksDone}/${p.chunksTotal} labels ${p.labelsDone}/${p.labelsTotal} pieces ${p.piecesDone}/${p.piecesTotal}${p.note ? ' | ' + p.note : ''}`
    if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`)
    last = line
  },
})
const collection = state.collection.mint
const pieces = state.pieces.map((p) => p.mint)
console.log(`minted in ${((Date.now() - t0) / 1000).toFixed(1)}s: collection ${collection}, pieces ${pieces.join(' ')}`)

// 2. creator verification: unverified before, one batch signs all five, verified after
const all = [collection, ...pieces]
const before = await Promise.all(all.map(creatorFlags))
check('collection and pieces list the deployer as an unverified creator', before.every((c) => c.length === 1 && c[0].address === kp.publicKey.toBase58() && c[0].verified === 0), JSON.stringify(before.map((c) => c[0]?.verified)))
const plan1 = await planCreatorVerify(conn, kp.publicKey, all)
check('verify plan: 5 signatures, 0 verified, 0 missing, one transaction', plan1.unverified === 5 && plan1.verified === 0 && plan1.missing === 0 && plan1.batches.length === 1, `${plan1.unverified}/${plan1.verified}/${plan1.missing} in ${plan1.batches.length}`)
await runBatches({ connection: conn, signer, batches: plan1.batches, onUpdate: (b) => b.status !== 'signing' && b.status !== 'sending' && console.log(`  batch ${b.id} ${b.status} ${b.signature ?? ''} ${b.error ?? ''}`) })
check('sign batch confirmed', plan1.batches.every((b) => b.status === 'confirmed'))
const after = await Promise.all(all.map(creatorFlags))
check('every creator flag reads verified by the independent walk', after.every((c) => c[0]?.verified === 1), JSON.stringify(after.map((c) => c[0]?.verified)))
const plan2 = await planCreatorVerify(conn, kp.publicKey, all)
check('a second plan finds nothing to sign', plan2.unverified === 0 && plan2.verified === 5 && plan2.batches.length === 0)
const foreign = await planCreatorVerify(conn, Keypair.generate().publicKey, all)
check('a wallet that is not the creator has nothing to sign: all missing', foreign.unverified === 0 && foreign.missing === 5)

// 3. the wallet's NFTs grouped by collection
const owned = await fetchOwnedAccounts(conn, kp.publicKey)
const { groups, mints: nftMints } = await fetchWalletNfts(conn, owned)
console.log('groups:', groups.map((g) => `${g.name} [${g.symbol}] ${g.pieces.length}: ${g.pieces.map((p) => p.name).join(', ')}`).join(' | '))
const mine = groups.find((g) => g.collection === collection)
check('the new collection is a group named from its metadata', !!mine && mine.name === form.name && mine.symbol === form.symbol)
check('its four pieces are the minted ones, in #1..#4 order', !!mine && mine.pieces.map((p) => p.mint).join() === pieces.join() && mine.pieces.map((p) => p.name).join() === [1, 2, 3, 4].map((n) => `${form.name} #${n}`).join())
const old = groups.find((g) => g.collection === OLD_COLLECTION)
check('the older test collection groups its piece #1', !!old && old.pieces.length === 1 && old.pieces[0].mint === OLD_PIECE)
const allPieceMints = new Set(groups.flatMap((g) => g.pieces.map((p) => p.mint)))
check('collection parents are not offered as pieces', !allPieceMints.has(collection) && !allPieceMints.has(OLD_COLLECTION))
check('collection parents and pieces both count as NFTs, so the token list leaves them out', nftMints.has(collection) && nftMints.has(OLD_COLLECTION) && nftMints.has(OLD_PIECE) && pieces.every((m) => nftMints.has(m)))

// 4. airdrop: three recipients get pieces #1..#3 in order; the fourth stays; an invalid line and a duplicate are dropped
const fresh = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()]
const wanted = [NIGHTLY, ...fresh]
const asset = nftAsset(mine!)
const plan = await planAirdrop(conn, kp.publicKey, asset, [...wanted, 'not-an-address', NIGHTLY].map((owner) => ({ owner, amount: 1n })))
check('plan: 3 recipients, 1 invalid, 0 left out, 3 new token accounts, 1 piece each', plan.recipients.length === 3 && plan.invalid.length === 1 && plan.withoutPiece === 0 && plan.ataCreates === 3 && plan.recipients.every((r) => r.amount === 1n))
check('plan pairs piece i with recipient i', !!plan.pieces && plan.pieces.map((p) => p.mint).join() === pieces.slice(0, 3).join() && plan.recipients.map((r) => r.owner).join() === wanted.join())
check('plan: rent for 3 accounts, one transaction, total 3', plan.rentLamports === 3n * 2_039_280n && plan.batches.length === 1 && plan.totalAmount === 3n, `${plan.batches.length} tx, ${cook(plan.rentLamports)} rent`)
const wide = await planAirdrop(conn, kp.publicKey, asset, [...wanted, ...Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58())].map((owner) => ({ owner, amount: 1n })))
check('six recipients for four pieces: four planned, two left out', wide.recipients.length === 4 && wide.withoutPiece === 2 && wide.pieces?.length === 4)
await runBatches({ connection: conn, signer, batches: plan.batches, onUpdate: (b) => b.status !== 'signing' && b.status !== 'sending' && console.log(`  batch ${b.id} ${b.status} ${b.signature ?? ''} ${b.error ?? ''}`) })
check('airdrop batch confirmed', plan.batches.every((b) => b.status === 'confirmed'))
const owners = await Promise.all(pieces.map(ownerOf))
check('pieces #1..#3 are held by the three recipients (RPC largest accounts)', owners.slice(0, 3).join() === wanted.join(), owners.map((o) => o?.slice(0, 6)).join(' '))
check('piece #4 stayed with the deployer', owners[3] === kp.publicKey.toBase58())
const groupsAfter = (await fetchWalletNfts(conn, await fetchOwnedAccounts(conn, kp.publicKey))).groups
const mineAfter = groupsAfter.find((g) => g.collection === collection)
check('the wallet now shows one piece of the collection', !!mineAfter && mineAfter.pieces.length === 1 && mineAfter.pieces[0].mint === pieces[3])

console.log(`balance ${cook(await conn.getBalance(kp.publicKey))} COOK`)
console.log(`--- ${fails ? `${fails} failed` : 'all passed'} ---`)
process.exit(fails ? 1 : 0)
