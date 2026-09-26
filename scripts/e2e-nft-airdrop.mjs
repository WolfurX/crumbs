// Drives the built app in a headless Brave and checks the NFT airdrop and the Mint done screen through a
// fake Wallet Standard wallet that connects as the deployer (read-only, it cannot sign). Expected values
// come from the chain by another route: the wallet's collections and piece counts from its token accounts
// and a byte walk of their metadata, the test collection's holders from the mints the mint engine
// recorded. Usage: brave --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/x http://localhost:4173/crumbs/#airdrop &
//        STATE=~/.config/crumbs/nft-airdrop-test-state.json OLD_STATE=~/.config/crumbs/mint-test-state.json node scripts/e2e-nft-airdrop.mjs
import { existsSync, readFileSync, statSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { connect, sleep } from './cdp.mjs'

const RPC = 'https://rpc.cookiescan.io'
const METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const OWNER = process.env.OWNER ?? 'GUiLxP1nZ93gXPENU3nMjhXQCt32QLfguW3sH8L6XHZK'
const NIGHTLY = 'FcxKQjZVoej6AP4aLd9x6BwrSFg8LCZPbjiLdmL9wgJo'
const home = (p) => p.replace(/^~/, process.env.HOME)
const states = (file) => Object.values(JSON.parse(readFileSync(home(file), 'utf8'))).map((raw) => ({ raw, ...JSON.parse(raw) }))
const fresh = states(process.env.STATE ?? '~/.config/crumbs/nft-airdrop-test-state.json').find((d) => d.stage === 'done')
const old = states(process.env.OLD_STATE ?? '~/.config/crumbs/mint-test-state.json').find((d) => d.stage === 'done')

const call = async (method, params) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r.result
}
const pda = (mint) => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA.toBuffer(), new PublicKey(mint).toBuffer()], METADATA)[0].toBase58()
/** Name and verified collection pointer of a metadata account, walked by hand. */
function walk(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 65
  const str = () => { const n = v.getUint32(o, true); const s = Buffer.from(data.subarray(o + 4, o + 4 + n)).toString('utf8').replace(/\0+$/, '').trim(); o += 4 + n; return s }
  const name = str()
  str(); str()
  o += 2
  if (data[o++] === 1) o += 4 + 34 * v.getUint32(o, true)
  o += 2
  if (data[o++] === 1) o++
  if (data[o++] === 1) o++
  return { name, collection: data[o] === 1 && data[o + 1] === 1 ? new PublicKey(data.subarray(o + 2, o + 34)).toBase58() : null }
}
const metaOf = async (mints) => {
  const out = new Map()
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const accs = (await call('getMultipleAccounts', [chunk.map(pda), { encoding: 'base64' }])).value
    chunk.forEach((m, k) => accs[k] && out.set(m, walk(Buffer.from(accs[k].data[0], 'base64'))))
  }
  return out
}

// expected: the wallet's collections and how many pieces of each it holds
const accounts = (await call('getTokenAccountsByOwner', [OWNER, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }])).value
const ones = accounts.map((a) => a.account.data.parsed.info).filter((i) => i.tokenAmount.decimals === 0 && i.tokenAmount.amount === '1' && i.state !== 'frozen').map((i) => i.mint)
const metas = await metaOf(ones)
const byCollection = new Map()
for (const m of ones) {
  const c = metas.get(m)?.collection
  if (c) byCollection.set(c, (byCollection.get(c) ?? 0) + 1)
}
const parents = await metaOf([...byCollection.keys()])
const expectedLabels = [...byCollection].map(([c, n]) => `${parents.get(c)?.name ?? c.slice(0, 4) + '…' + c.slice(-4)} · ${n} piece${n === 1 ? '' : 's'}`).sort()
console.log(`expected NFT options for ${OWNER.slice(0, 6)}: ${expectedLabels.join(' | ')}`)
const freshHeld = byCollection.get(fresh.collection.mint) ?? 0
// the older test collection's holders, from the mints the mint engine recorded
const oldOwners = []
for (const p of old.pieces) {
  const largest = (await call('getTokenLargestAccounts', [p.mint])).value.find((a) => a.amount === '1')
  if (largest) oldOwners.push((await call('getAccountInfo', [largest.address, { encoding: 'jsonParsed' }])).value.data.parsed.info.owner)
}
const oldHolders = new Set(oldOwners).size
const oldRecipients = new Set(oldOwners.filter((o) => o !== OWNER)).size
console.log(`older collection ${old.collection.mint.slice(0, 6)}: ${oldHolders} holders, ${oldRecipients} besides the deployer, deployer holds ${byCollection.get(old.collection.mint) ?? 0}`)

const cdp = await connect(Number(process.env.CDP_PORT ?? 9222), (t) => t.url.includes(process.env.APP_MATCH ?? '/crumbs/'))
const logs = []
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
cdp.on('Runtime.consoleAPICalled', (p) => logs.push(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`))
cdp.on('Runtime.exceptionThrown', (p) => logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`))
cdp.on('Log.entryAdded', (p) => logs.push(`[${p.entry.level}] ${p.entry.text}`))
const downloads = `${process.cwd()}/shots`
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => console.log('    (download capture unavailable)'))

let fails = 0
const $ = (expr) => cdp.evaluate(expr)
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) fails++ }
const clickTab = async (label) => { await $(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(), true`); await sleep(250) }
const clickButton = async (text) => { await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)})).click(), true`); await sleep(200) }
const setInput = (selector, value) => $(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`)
const selectValue = (value) => $(`(() => { const el = document.querySelector('select.input'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value })()`)
// tabs stay mounted once visited, so every query stays inside the panel on screen
const VIS = '.panel:not([hidden])'
const tile = (label) => $(`[...document.querySelectorAll('${VIS} .tile')].find((t) => t.querySelector('.label').textContent === ${JSON.stringify(label)})?.querySelector('.value').textContent`)
const text = () => $(`document.body.textContent.replace(/\\s+/g, ' ')`)
const shot = async (name) => { await cdp.screenshot(`shots/${name}.png`); console.log(`    shot shots/${name}.png`) }
const connectFake = async (owner, name = 'FakeWallet') => {
  await $(`(() => {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const unb58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n } for (const c of s) { if (c === '1') out.unshift(0); else break } return new Uint8Array(out) };
    const account = { address: ${JSON.stringify(owner)}, publicKey: unb58(${JSON.stringify(owner)}), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
    const wallet = {
      version: '1.0.0', name: ${JSON.stringify(name)}, icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: ['solana:mainnet'], accounts: [],
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
  // after a reload the adapter remembers the wallet name and reconnects as soon as it registers
  if (!(await $(`!!document.querySelector('.wallet .mono') || !!document.querySelector('.wallet .name')`))) {
    await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Connect wallet')).click(), true`)
    await sleep(300)
    await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes(${JSON.stringify(name)})).click(), true`)
  }
  await cdp.waitFor(`!!document.querySelector('.wallet .mono') || !!document.querySelector('.wallet .name')`, 10000)
}
const disconnect = async () => {
  await $(`[...document.querySelectorAll('.wallet button')][0].click(), true`)
  await sleep(200)
  await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Disconnect')).click(), true`)
  await cdp.waitFor(`!!document.querySelector('.wallet') && !document.querySelector('.wallet .mono') && !document.querySelector('.wallet .name')`, 10000)
}

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
await cdp.waitFor(`!!document.querySelector('[role=tab][aria-selected=true]')`)
await connectFake(OWNER)
check('fake wallet connected as the deployer', true)

// 1. pasted list: two wallets, one piece in the wallet, one recipient left out
await cdp.waitFor(`document.querySelector('.seg button[aria-pressed="true"]') !== null`, 10000)
await $(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Pasted list').click(), true`)
await sleep(200)
await setInput('textarea.input', `${NIGHTLY}, 5\n${fresh.pieces[0].mint.slice(0, 44)}`)
await sleep(200)
await clickButton('Continue with 2 recipients')
await cdp.waitFor(`!!document.querySelector('select.input')`, 5000)
await cdp.waitFor(`!!document.querySelector('select.input optgroup[label^="NFT"]')`, 20000)
const labels = await $(`[...document.querySelectorAll('select.input optgroup[label^="NFT"] option')].map((o) => o.textContent).sort()`)
check('the Send menu lists the wallet collections with their piece counts', JSON.stringify(labels) === JSON.stringify(expectedLabels), labels.join(' | '))
const tokens = await $(`[...document.querySelectorAll('select.input optgroup[label="Tokens"] option')].map((o) => o.textContent)`)
check('NFT mints stay out of the token list', tokens.every((l) => !/ · 1$/.test(l)) && tokens[0].startsWith('COOK'), tokens.join(' | '))
await selectValue(`nft:${fresh.collection.mint}`)
await sleep(200)
const pieceLine = (held, n) => `Up to ${Math.min(held, n)} of your ${held} piece${held === 1 ? '' : 's'} go${Math.min(held, n) === 1 ? 'es' : ''} out, one per wallet${n > held ? `; at most ${n - held} wallet${n - held === 1 ? ' is' : 's are'} left out` : ''}. The review shows the exact split.`
check(`picking a collection shows the piece line (${freshHeld} held, 2 recipients)`, (await text()).includes(pieceLine(freshHeld, 2)) && !(await $(`!!document.querySelector('.seg[aria-label="Amount mode"]')`)))
check('the amount field is gone and Review is enabled', await $(`!document.querySelector('input.num') && ![...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Review')).disabled`))
await shot('nft-airdrop-amount')
await clickButton('Review')
await cdp.waitFor(`document.querySelectorAll('${VIS} .tile').length >= 4`, 30000)
check('review: one recipient, one piece, one transaction, rent for one account', (await tile('Recipients')) === String(freshHeld) && (await tile(`${fresh.form.symbol} pieces`)) === String(freshHeld) && (await tile('Transactions')) === '1' && (await tile('Rent for new accounts')) === '0.00203928 COOK')
check('review notes the recipient left out and the new token account', /1 recipient left out: you hold 1 piece\./.test(await text()) && /1 recipient gets a new token account/.test(await text()))
check('the stepper sums it as pieces', await $(`[...document.querySelectorAll('.step')].some((s) => /1 piece$/.test(s.textContent.trim()))`))
await shot('nft-airdrop-review')
await clickButton('Sign and send 1 transaction')
await cdp.waitFor(`document.body.textContent.includes('fake wallet cannot sign')`, 15000)
check('a refused signature marks the batch failed with a retry', await $(`document.querySelector('.batch')?.textContent.includes('Failed') && !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Retry failed'))`))

// 2. a collection snapshot as the source: skip-my-wallet leaves the other holders, pieces cap the plan
check('a failed run offers a way out', await $(`!![...document.querySelectorAll('${VIS} button')].find((b) => b.textContent.trim() === 'Start over')`))
await clickButton('Start over')
check('start over returns to step 1 with the list kept', await $(`document.querySelector('${VIS} .step[aria-current="step"] .n')?.textContent === '1' && document.querySelector('${VIS} textarea.input')?.value.includes(${JSON.stringify(NIGHTLY)})`))
await clickTab('Snapshot')
await setInput('input.input', old.collection.mint)
await sleep(200)
// the public RPC drops a fetch now and then; the app shows the error and the user clicks again, so does this
for (let attempt = 0; ; attempt++) {
  await clickButton('Take snapshot')
  await cdp.waitFor(`(document.querySelectorAll('${VIS} .tile').length >= 4 && document.querySelector('.tokenhead .pill')?.textContent === 'NFT collection') || !!document.querySelector('${VIS} .err')`, 60000)
  if (await $(`document.querySelector('.tokenhead .pill')?.textContent === 'NFT collection'`)) break
  const err = await $(`document.querySelector('${VIS} .err')?.textContent`)
  if (attempt >= 2) throw new Error(`snapshot kept failing: ${err}`)
  console.log(`    snapshot attempt ${attempt + 1} failed (${err}), retrying`)
  await sleep(1500)
}
check(`snapshot of the older test collection: ${oldHolders} holders`, (await tile('Holders')) === String(oldHolders))
await clickTab('Airdrop')
await cdp.waitFor(`document.body.textContent.includes('recipients after filters')`, 10000)
const recipients = await $(`Number([...document.querySelectorAll('.ink2')].find((e) => e.textContent.includes('recipients after filters')).querySelector('b').textContent.replace(/,/g, ''))`)
check(`the snapshot feeds the airdrop, my wallet skipped (${recipients})`, recipients === oldRecipients)
await clickButton(`Continue with ${oldRecipients} recipient`)
await cdp.waitFor(`!!document.querySelector('select.input optgroup[label^="NFT"]')`, 20000)
await selectValue(`nft:${old.collection.mint}`)
await sleep(200)
const held = byCollection.get(old.collection.mint) ?? 0
check('pieces line against the snapshot recipients', (await text()).includes(pieceLine(held, oldRecipients)))
await clickButton('Review')
await cdp.waitFor(`document.querySelectorAll('${VIS} .tile').length >= 4`, 30000)
check('review plans min(pieces, recipients)', (await tile('Recipients')) === String(Math.min(held, oldRecipients)) && (await tile(`${old.form.symbol} pieces`)) === String(Math.min(held, oldRecipients)))

// 3. the Mint done screen: a finished drop comes back after a reload, verified creator read from the chain, share card rendered
await $(`localStorage.setItem(${JSON.stringify(`crumbs.drop.${OWNER}`)}, ${JSON.stringify(fresh.raw)}), true`)
await $(`location.hash = '#mint', true`)
await cdp.send('Page.reload')
await sleep(1500)
await cdp.waitFor(`!!document.querySelector('[role=tab][aria-selected=true]')`, 15000)
await connectFake(OWNER)
await cdp.waitFor(`document.body.textContent.includes('You are the verified creator of every piece.')`, 30000)
check('done screen restored after reload; every creator flag read as verified', (await text()).includes(`Done. ${fresh.pieces.length} pieces are in your wallet.`))
check('the verified state is saved with the drop', await $(`JSON.parse(localStorage.getItem(${JSON.stringify(`crumbs.drop.${OWNER}`)})).creatorVerified === true`))
await shot('nft-mint-verified')
await clickButton('Share a card')
await cdp.waitFor(`document.body.textContent.includes('Share card saved as PNG')`, 15000)
await sleep(800)
const cardPath = `${downloads}/${fresh.form.symbol.toLowerCase()}-drop.png`
const card = existsSync(cardPath) ? readFileSync(cardPath) : null
check('share card saved as a 1200x630 PNG', !!card && card.subarray(1, 4).toString() === 'PNG' && card.readUInt32BE(16) === 1200 && card.readUInt32BE(20) === 630, card ? `${statSync(cardPath).size} bytes` : 'no file')
// another wallet with no drop of its own does not inherit the done screen; the creator gets it back
await disconnect()
await connectFake(NIGHTLY, 'FakeOther')
await cdp.waitFor(`!document.body.textContent.includes('Done. ') && !!document.querySelector('${VIS} .dropzone')`, 10000)
check('a wallet that did not make the drop sees the form, not the done screen', await $(`!document.querySelector('${VIS} .verify')`))
await disconnect()
await connectFake(OWNER)
await cdp.waitFor(`document.body.textContent.includes('You are the verified creator of every piece.')`, 30000)
check('the creator gets the done screen back', (await text()).includes(`Done. ${fresh.pieces.length} pieces are in your wallet.`))

// 4. a drop whose creator is still unverified offers the signing; a refused signature fails cleanly
await $(`localStorage.setItem(${JSON.stringify(`crumbs.drop.${OWNER}`)}, ${JSON.stringify(old.raw)}), true`)
await cdp.send('Page.reload')
await sleep(1500)
await cdp.waitFor(`!!document.querySelector('[role=tab][aria-selected=true]')`, 15000)
await connectFake(OWNER)
await cdp.waitFor(`document.body.textContent.includes('Verify yourself as the creator')`, 30000)
const n = old.pieces.length + 1
check(`unverified drop: ${n} of ${n} unverified, ${n} signatures in one transaction offered`, (await text()).includes(`${n} of ${n} still list your wallet as an unverified creator`) && (await text()).includes(`${n} signatures in 1 transaction`))
await shot('nft-mint-verify')
await clickButton('Sign and verify')
await cdp.waitFor(`document.body.textContent.includes('fake wallet cannot sign')`, 15000)
check('refused signature: batch failed, retry offered, drop not marked verified', await $(`document.querySelector('.verify .batch')?.textContent.includes('Failed') && !![...document.querySelectorAll('.verify button')].find((b) => b.textContent.includes('Retry failed')) && !JSON.parse(localStorage.getItem(${JSON.stringify(`crumbs.drop.${OWNER}`)})).creatorVerified`))

// 5. phone
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(500)
await $(`document.querySelector('.verify').scrollIntoView({ block: 'center' }), true`)
await sleep(300)
await shot('nft-mint-verify-phone')
await $(`localStorage.removeItem(${JSON.stringify(`crumbs.drop.${OWNER}`)}), true`)
await cdp.send('Emulation.clearDeviceMetricsOverride')

console.log(`--- ${fails ? `${fails} failed` : 'all passed'} ---`)
const noise = /GPU stall|ReadPixels|Automatic fallback to software WebGL|WalletNotSelectedError|beforeinstallprompt|fake wallet cannot sign/
console.log(logs.filter((l) => !noise.test(l)).join('\n') || '(console clean)')
cdp.close()
process.exit(fails ? 1 : 0)
