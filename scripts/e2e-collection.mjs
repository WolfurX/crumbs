// Drives the built app in a headless Brave and checks NFT collection snapshots against numbers worked
// out another way: pieces and owners from the Cookiescan DAS index (pieces that since left the
// collection dropped by reading their metadata), or, for a collection DAS has not indexed, from the
// piece mints the Mint engine recorded (STATE, its local state file) and getTokenLargestAccounts.
// Also: the pasted-piece hint, the snapshot surviving a reload, and the Airdrop tab picking it up.
// Usage: brave --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/x http://localhost:4173/crumbs/ &
//        STATE=~/.config/crumbs/mint-test-state.json node scripts/e2e-collection.mjs
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { connect, sleep } from './cdp.mjs'

const RPC = 'https://rpc.cookiescan.io'
const DAS = 'https://api.cookiescan.io'
const METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const SESAMIANS = 'GT8RwC8SowwEP5k7YLp59yXMJNpmCd7tgMHgdP7BA24S'
const COLLECTIONS = (process.env.COLLECTIONS ?? `${SESAMIANS},FBJ47AgQSzSWVQVzsspoUzcFVeEf8a6xihZKZgmRuno1`).split(',')

const call = async (url, method, params) => {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r.result
}
const onCurve = (a) => PublicKey.isOnCurve(new PublicKey(a).toBytes())
const tally = (owners) => {
  const people = owners.filter(onCurve)
  return { pieces: people.length, holders: new Set(people).size, piecesAll: owners.length, holdersAll: new Set(owners).size }
}

/** The collection pointer in a metadata account, read field by field. */
function pointer(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 65
  for (let i = 0; i < 3; i++) o += 4 + v.getUint32(o, true)
  o += 2
  if (data[o++] === 1) o += 4 + 34 * v.getUint32(o, true)
  o += 2
  if (data[o++] === 1) o++
  if (data[o++] === 1) o++
  return data[o] === 1 && data[o + 1] === 1 ? new PublicKey(data.subarray(o + 2, o + 34)).toBase58() : null
}

async function fromDas(collection) {
  const items = []
  for (let page = 1; ; page++) {
    const r = await call(DAS, 'getAssetsByGroup', { groupKey: 'collection', groupValue: collection, page, limit: 1000 })
    items.push(...r.items.filter((i) => !i.burnt))
    if (r.items.length < 1000) break
  }
  if (!items.length) return null
  const still = []
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100)
    const pdas = chunk.map((a) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA.toBuffer(), new PublicKey(a.id).toBuffer()], METADATA)[0].toBase58())
    const accs = (await call(RPC, 'getMultipleAccounts', [pdas, { encoding: 'base64' }])).value
    chunk.forEach((a, k) => accs[k] && pointer(Buffer.from(accs[k].data[0], 'base64')) === collection && still.push(a))
  }
  return { ...tally(still.map((a) => a.ownership.owner)), stale: items.length - still.length, piece: still[0].id, source: 'DAS' }
}

async function fromMints(mints) {
  const owners = []
  for (const mint of mints) {
    const largest = (await call(RPC, 'getTokenLargestAccounts', [mint])).value.find((a) => a.amount === '1')
    if (!largest) continue
    const acc = await call(RPC, 'getAccountInfo', [largest.address, { encoding: 'jsonParsed' }])
    owners.push(acc.value.data.parsed.info.owner)
  }
  return { ...tally(owners), stale: 0, piece: mints[0], source: 'recorded mints' }
}

const recorded = new Map()
if (process.env.STATE) {
  for (const raw of Object.values(JSON.parse(readFileSync(process.env.STATE.replace(/^~/, process.env.HOME), 'utf8')))) {
    const d = JSON.parse(raw)
    if (d.collection?.mint) recorded.set(d.collection.mint, d.pieces.filter((p) => p.done).map((p) => p.mint))
  }
  COLLECTIONS.push(...[...recorded.keys()].filter((c) => !COLLECTIONS.includes(c)))
}

const cdp = await connect(Number(process.env.CDP_PORT ?? 9222), (t) => t.url.includes(process.env.APP_MATCH ?? '/crumbs/'))
const logs = []
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
cdp.on('Runtime.consoleAPICalled', (p) => logs.push(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`))
cdp.on('Runtime.exceptionThrown', (p) => logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`))
cdp.on('Log.entryAdded', (p) => logs.push(`[${p.entry.level}] ${p.entry.text}`))

let fails = 0
const $ = (expr) => cdp.evaluate(expr)
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) fails++ }
const setInput = (selector, value) => $(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`)
const clickButton = (text) => $(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click(), true`)
const clickTab = async (label) => { await $(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(), true`); await sleep(300) }
const tile = (label) => $(`(() => { const t = [...document.querySelectorAll('.tile')].find((t) => t.querySelector('.label').textContent === ${JSON.stringify(label)}); return t ? Number(t.querySelector('.value').textContent.replace(/,/g, '')) : null })()`)
const setPrograms = (hide) => $(`(() => { const c = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('Hide program accounts')).querySelector('input'); if (c.checked !== ${hide}) c.click(); return true })()`)
const shot = async (name) => { await cdp.screenshot(`shots/${name}.png`); console.log(`    shot shots/${name}.png`) }
const snapshotOf = async (address) => {
  await setInput('input.input', address)
  await sleep(200)
  const t0 = Date.now()
  await clickButton('Take snapshot')
  await cdp.waitFor(`document.querySelector('.tokenhead .small .mono')?.textContent.startsWith(${JSON.stringify(address.slice(0, 6))}) && !!document.querySelector('.tokenhead .pill')`, 60000)
  return Date.now() - t0
}

await cdp.waitFor(`document.querySelector('h2')?.textContent === 'Holder snapshot'`)
let last = null
for (const collection of COLLECTIONS) {
  const want = recorded.has(collection) ? await fromMints(recorded.get(collection)) : await fromDas(collection)
  const ms = await snapshotOf(collection)
  const got = { holders: await tile('Holders'), pieces: await tile('Pieces held') }
  await setPrograms(false)
  await sleep(200)
  const all = { holders: await tile('Holders'), pieces: await tile('Pieces held') }
  await setPrograms(true)
  const name = await $(`document.querySelector('.tokenhead h2').textContent`)
  console.log(`${collection.slice(0, 8)} "${name}" in ${(ms / 1000).toFixed(1)} s: ${got.holders} holders / ${got.pieces} pieces, with programs ${all.holders} / ${all.pieces}`)
  if (want) {
    console.log(`    expected from ${want.source}: ${want.holders} / ${want.pieces}, with programs ${want.holdersAll} / ${want.piecesAll}${want.stale ? ` (${want.stale} pieces DAS still groups here dropped: their metadata no longer points at it)` : ''}`)
    check(`${collection.slice(0, 8)} holders and pieces match`, got.holders === want.holders && got.pieces === want.pieces)
    check(`${collection.slice(0, 8)} with program accounts match`, all.holders === want.holdersAll && all.pieces === want.piecesAll)
    last = { collection, ...want }
  } else console.log('    no independent source: DAS has not indexed it and no recorded mints')
  check(`${collection.slice(0, 8)} labelled as a collection, table in pieces`, await $(`document.querySelector('.tokenhead .pill')?.textContent === 'NFT collection' && [...document.querySelectorAll('thead th')].some((t) => t.textContent.trim() === 'Pieces')`))
  await shot(`collection-${collection.slice(0, 8)}`)
}

if (last) {
  // a pasted piece offers its collection instead of a one-holder snapshot
  await setInput('input.input', last.piece)
  await sleep(200)
  await clickButton('Take snapshot')
  await cdp.waitFor(`document.body.textContent.includes('That is one NFT of a collection.')`, 30000)
  check('a pasted piece offers its collection', true)
  await clickButton('Snapshot the collection')
  await cdp.waitFor(`document.querySelector('.tokenhead .small .mono')?.textContent.startsWith(${JSON.stringify(last.collection.slice(0, 6))})`, 60000)
  check('the offer takes the collection snapshot', (await tile('Holders')) === last.holders)

  // the snapshot survives a reload and feeds the Airdrop tab
  await cdp.send('Page.reload')
  await sleep(1500)
  await cdp.waitFor(`document.querySelectorAll('.tile').length >= 4`, 15000)
  check('reload restores the collection snapshot', (await $(`document.querySelector('.tokenhead .pill')?.textContent`)) === 'NFT collection' && (await tile('Holders')) === last.holders)
  // the airdrop steps render once a wallet is connected: a fake Wallet Standard wallet that cannot sign
  await $(`(() => {
    const pk = new Uint8Array(32); pk[0] = 7; pk[31] = 9;
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const b58 = (b) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n } for (const x of b) { if (x === 0) s = '1' + s; else break } return s };
    const account = { address: b58(pk), publicKey: pk, chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
    const wallet = {
      version: '1.0.0', name: 'FakeWallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: ['solana:mainnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; return { accounts: [account] } } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = [] } },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async () => { throw new Error('fake wallet cannot sign') } },
      },
    };
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet) }));
    return true })()`)
  await sleep(500)
  await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Connect wallet')).click(), true`)
  await sleep(300)
  await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('FakeWallet')).click(), true`)
  await cdp.waitFor(`!!document.querySelector('.wallet .mono')`, 10000)
  await clickTab('Airdrop')
  await cdp.waitFor(`document.body.textContent.includes('recipients after filters')`, 10000)
  const recipients = await $(`Number([...document.querySelectorAll('.ink2')].find((e) => e.textContent.includes('recipients after filters')).querySelector('b').textContent.replace(/,/g, ''))`)
  check(`airdrop takes the snapshot (${recipients} recipients), min field in pieces`, recipients === last.holders && (await $(`document.body.textContent.includes('Min pieces held')`)))
  await shot('collection-airdrop')
}

console.log(`--- ${fails ? `${fails} failed` : 'all passed'} ---`)
console.log(logs.join('\n') || '(console clean)')
cdp.close()
process.exit(fails ? 1 : 0)
