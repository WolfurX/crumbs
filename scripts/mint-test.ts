// Live quick-drop test: runs the real src/mint engine with the deployer keypair instead of a
// wallet. Stores public/og.png as the picture (raw bytes, the browser resize step is skipped),
// mints a 3-piece collection to the deployer and two fresh wallets, then reads everything back
// from the chain, the gateway, Cookiescan DAS and Baked Bazaar. Spends about 1 COOK.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { RPC_URL, DAS_URL } from '../src/lib/chain'
import type { Signer } from '../src/lib/txs'
import { newDrop, runDrop, type Progress } from '../src/mint/engine'
import { readBlob, blobUrl } from '../src/mint/blob'
import { estimate, fetchRents } from '../src/mint/plan'
import { metadataPda } from '../src/mint/tm'
import { loadDrop } from '../src/mint/engine'
// Node has no localStorage: keep the drop state in a file so a killed run can resume and nothing strands.
import { existsSync, writeFileSync } from 'node:fs'
const STATE_FILE = `${process.env.HOME}/.config/crumbs/mint-test-state.json`
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
const cook = (n: bigint | number) => (Number(n) / 1e9).toFixed(4)
const bal = async () => cook(await conn.getBalance(kp.publicKey))

const png = new Uint8Array(readFileSync('public/og.png'))
console.log('deployer', kp.publicKey.toBase58(), 'balance', await bal(), 'COOK; picture', png.length, 'bytes')

const form = { name: 'Crumbs Test Pass', symbol: 'CTP', description: 'Engine test of the Crumbs quick drop. Safe to ignore.', royaltyBps: 500 }
const rents = await fetchRents(conn)
const est = estimate(rents, form, png.length, 'image/png', 3)
console.log(`estimate: image ${cook(est.image)} labels ${cook(est.labels)} pieces ${cook(est.pieces)} fees ${cook(est.fees)} total ${cook(est.total)} COOK; store txs ${est.storeTxs}, mint txs ${est.mintTxs}`)

const recipients = [kp.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey]
const resumed = process.env.RESUME ? loadDrop(kp.publicKey) : null
if (resumed) console.log('resuming drop from', resumed.stage)
const state = resumed ?? newDrop(kp.publicKey, form, recipients, { bytes: png, mime: 'image/png', width: 1200, height: 630 })
const t0 = Date.now()
let last = ''
await runDrop(conn, signer, state, {
  onProgress: (p: Progress) => {
    const line = `${p.stage} chunks ${p.chunksDone}/${p.chunksTotal} labels ${p.labelsDone}/${p.labelsTotal} pieces ${p.piecesDone}/${p.piecesTotal}${p.prompt ? ' PROMPT ' + p.prompt : ''}${p.note ? ' | ' + p.note : ''}`
    if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`)
    last = line
  },
})
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, balance ${await bal()} COOK`)
console.log('collection', state.collection.mint, 'pieces', state.pieces.map((p) => p.mint).join(' '))
console.log('image blob', state.imageBlob.pubkey, blobUrl(state.imageBlob.pubkey))

// read back
const img = await readBlob(conn, new PublicKey(state.imageBlob.pubkey))
console.log('image blob on chain:', img ? `${img.mime} ${img.bytes.length} bytes finalized=${img.finalized} authority=${img.authority.toBase58().slice(0, 6)} equal=${Buffer.from(img.bytes).equals(Buffer.from(png))}` : 'MISSING')
const label = await readBlob(conn, new PublicKey(state.pieceBlobs[0].pubkey))
console.log('label 1:', label ? `${label.mime} ${new TextDecoder().decode(label.bytes)}` : 'MISSING')
const meta = await conn.getAccountInfo(metadataPda(new PublicKey(state.pieces[0].mint)))
console.log('piece 1 metadata account:', meta ? `${meta.data.length} bytes` : 'MISSING')

for (const url of [blobUrl(state.imageBlob.pubkey), blobUrl(state.pieceBlobs[0].pubkey)]) {
  try {
    const r = await fetch(url)
    console.log('gateway', url.slice(-12), r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength, 'bytes')
  } catch (e) {
    console.log('gateway', url, 'error', (e as Error).message)
  }
}
const das = async (method: string, params: unknown) => (await (await fetch(DAS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
await new Promise((r) => setTimeout(r, 4000))
const asset = await das('getAsset', { id: state.pieces[1].mint })
console.log('DAS piece 2:', asset ? `${asset.interface} name=${asset.content?.metadata?.name} grouping=${JSON.stringify(asset.grouping)} owner=${asset.ownership?.owner?.slice(0, 6)} uri=${asset.content?.json_uri}` : 'not indexed yet')
const group = await das('getAssetsByGroup', { groupKey: 'collection', groupValue: state.collection.mint, page: 1, limit: 10 })
console.log('DAS collection group total:', group?.total)
try {
  const bz = await (await fetch(`https://bakedbazaar.art/api/nft/${state.pieces[0].mint}`, { headers: { 'user-agent': 'Mozilla/5.0' } })).text()
  console.log('bazaar piece 1:', bz.slice(0, 300))
} catch (e) {
  console.log('bazaar error', (e as Error).message)
}
// the RPC websocket keeps the event loop alive; leave explicitly
process.exit(0)
