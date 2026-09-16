// Drives the built app in a headless Brave and checks the quality-of-life behaviour: the tab in the
// hash, tabs staying mounted, the snapshot surviving a reload, the changelog, and the airdrop
// exclude list and history through a fake Wallet Standard wallet (no signing).
// Usage: brave --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/x http://localhost:4173/crumbs/#airdrop &
//        node scripts/e2e-qol.mjs
import { connect, sleep } from './cdp.mjs'

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
const activeTab = () => $(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()`)
const clickTab = async (label) => { await $(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(), true`); await sleep(250) }
const setInput = (selector, value) => $(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`)
const shot = async (name) => { await cdp.screenshot(`shots/${name}.png`); console.log(`    shot shots/${name}.png`) }

// 1. the hash opens the tab it names
await cdp.waitFor(`!!document.querySelector('[role=tab][aria-selected=true]')`)
check('#airdrop opens the Airdrop tab', (await activeTab()) === 'Airdrop')

// 2. the changelog is its own page behind the footer link; the tool view hides and comes back
check('home has no changelog section, footer links to it', await $(`!document.querySelector('.changelog') && document.querySelector('footer a[href="#changelog"]')?.textContent === 'Changelog'`))
await $(`document.querySelector('footer a[href="#changelog"]').click(), true`)
await sleep(300)
check('changelog page shows every entry and hides the tools', await $(`document.querySelector('#changelog-title')?.textContent === 'What changed' && document.querySelectorAll('.changelog-list li').length >= 5 && document.querySelector('.tabs').closest('[hidden]') !== null && document.title.startsWith('Changelog')`))
await shot('qol-changelog')
await $(`document.querySelector('.page .back').click(), true`)
await sleep(300)
check('back link returns to the tab you were on', await $(`!document.querySelector('.changelog') && document.title === 'Crumbs'`) && (await activeTab()) === 'Airdrop')

// 3. clicking a tab writes the hash; typed input survives a visit to another tab
await clickTab('Snapshot')
check('tab click sets the hash', await $(`location.hash === '#snapshot'`))
await setInput('input.input', 'bCO')
await clickTab('Clicker')
await clickTab('Snapshot')
check('snapshot input kept across a tab switch', (await $(`document.querySelector('input.input').value`)) === 'bCO')
check('visited panels stay mounted, one visible', await $(`document.querySelectorAll('.panel').length === 3 && [...document.querySelectorAll('.panel')].filter((p) => !p.hidden).length === 1`))
check('clicker panel kept, hidden', await $(`[...document.querySelectorAll('.panel')].some((p) => p.hidden && /clicker/i.test(p.textContent))`))

// 4. take a snapshot; it is stored, labelled with its age, and offers copy + retake
const mint = process.env.MINT ?? 'EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz' // bCOOK
await setInput('input.input', mint)
await sleep(200)
await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Take snapshot').click(), true`)
await cdp.waitFor(`document.querySelectorAll('.tile').length >= 4`, 60000)
const holders = await $(`document.querySelector('.tile .value').textContent`)
check(`snapshot taken (${holders} holders)`, Number(holders.replace(/,/g, '')) > 0)
check('snapshot stored locally', await $(`(() => { const s = JSON.parse(localStorage.getItem('crumbs.snapshot') || 'null'); return !!s && s.holders.length > 0 && s.token.mint === ${JSON.stringify(mint)} })()`))
check('age label, retake and copy addresses present', await $(`/taken \\d+s ago/.test(document.body.textContent) && !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Copy addresses')) && !!document.querySelector('button[title="Take this snapshot again now"]')`))
await shot('qol-snapshot')

// 5. the back button walks the tab history
await $(`history.back(), true`)
await sleep(300)
check('back returns to the previous tab', (await activeTab()) === 'Clicker')
await $(`history.forward(), true`)
await sleep(300)

// 6. reload: the snapshot comes back from storage and the hash picks the tab
{
  await $(`localStorage.setItem('crumbs.airdrops', JSON.stringify([{ id: 1, at: Date.now() - 3600e3, symbol: 'COOK', decimals: 9, total: '12500000000', recipients: 47, signatures: ['4NJJ5A6YzR3P7SH5Sv6HNKZvoPnEkL49NXNcNmNQDxnZTofBYAKRKtxPD9h3Lso23wAyPjjrmBf4tpbCztBb5PMm', '4xFVH7egN5eNaCN3aGkCQEUXJqkNSj8RAtCNELMTgdgc66FBoiPLMuSx5eQGt8s8Xc3S1WtsvhKZJjKb2kruFQVX'] /* real cancel txs from this wallet, so the links resolve */ }])), true`)
}
await cdp.send('Page.reload')
await sleep(1500)
await cdp.waitFor(`!!document.querySelector('[role=tab][aria-selected=true]')`)
check('tab restored from the hash after reload', (await activeTab()) === 'Snapshot')
await cdp.waitFor(`document.querySelectorAll('.tile').length >= 4`, 15000)
check('snapshot restored after reload with the same holder count', (await $(`document.querySelector('.tile .value').textContent`)) === holders)
check('restored snapshot is the stored one, not refetched', await $(`document.querySelectorAll('.recent').length === 0 && /taken \\d+[sm] ago/.test(document.body.textContent)`))

// 7. a fake Wallet Standard wallet, so the airdrop steps render without a browser extension
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
  return account.address })()`)
await sleep(500)
await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Connect wallet')).click(), true`)
await sleep(300)
await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('FakeWallet')).click(), true`)
await cdp.waitFor(`!!document.querySelector('.wallet .mono')`, 10000)
check('fake wallet connected', true)

await clickTab('Airdrop')
await sleep(300)
check('airdrop uses the restored snapshot as its source', await $(`document.querySelector('.seg button[aria-pressed="true"]')?.textContent === 'Snapshot holders' && /recipients after filters/.test(document.body.textContent)`))
const before = await $(`document.querySelector('.card .ink2 b.num')?.textContent`)
const firstOwner = await $(`JSON.parse(localStorage.getItem('crumbs.snapshot')).holders.find((h) => !h[3])[0]`)
await setInput('textarea.input', firstOwner)
await sleep(200)
const after = await $(`document.querySelector('.card .ink2 b.num')?.textContent`)
check(`exclude list drops a wallet (${before} to ${after})`, Number(before.replace(/,/g, '')) - Number(after.replace(/,/g, '')) === 1)
check('airdrop history renders with a Cookiescan link', await $(`/Airdrops sent from this browser/.test(document.body.textContent) && document.querySelectorAll('.history li').length === 1 && /47 wallets got 12\\.5 COOK/.test(document.querySelector('.history').textContent.replace(/\\s+/g, ' ')) && /\\+1 more/.test(document.querySelector('.history').textContent) && document.querySelector('.history a').href.includes('cookiescan.io/tx/')`))
await shot('qol-airdrop')

// 8. the maker's swap offer comes back from storage with its live status; cancelling it on chain
//    flips the status the next time the tab is opened. Needs `scripts/swap-offer-seed.ts make` first.
const seedPath = `${process.env.HOME}/.config/crumbs/qol-offer.json`
const seed = await import('node:fs').then((fs) => (fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : null))
if (seed) {
  await $(`[...document.querySelectorAll('.wallet button')][0].click(), true`)
  await sleep(200)
  await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Disconnect')).click(), true`)
  await sleep(500)
  await $(`localStorage.setItem(${JSON.stringify(`crumbs.offer.${seed.maker}`)}, ${JSON.stringify(seed.encoded)}), true`)
  await $(`(() => {
    const pk = Uint8Array.from(${JSON.stringify(seed.makerBytes)});
    const account = { address: ${JSON.stringify(seed.maker)}, publicKey: pk, chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
    const wallet = {
      version: '1.0.0', name: 'FakeMaker', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: ['solana:mainnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; return { accounts: [account] } } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = [] } },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async () => { throw new Error('fake wallet cannot sign') } },
      },
    };
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: ({ register }) => register(wallet) }));
    return true })()`)
  await sleep(300)
  await $(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Connect wallet')).click(), true`)
  await sleep(300)
  await $(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('FakeMaker')).click(), true`)
  await cdp.waitFor(`!!document.querySelector('.wallet .mono') || !!document.querySelector('.wallet .name')`, 10000)
  await clickTab('Swap')
  await cdp.waitFor(`/Your open offer/.test(document.body.textContent) && document.querySelector('.notice .pill')?.textContent === 'open'`, 15000)
  check('maker offer restored from storage and reads open', true)
  check('restored offer has the link, copy and cancel', await $(`!!document.querySelector('.notice input[readonly]')?.value.includes('#swap=') && !![...document.querySelectorAll('.notice button')].find((b) => b.textContent.includes('Cancel offer'))`))
  await $(`document.querySelector('.notice').scrollIntoView({ block: 'center' }), true`)
  await sleep(200)
  await shot('qol-swap-open')
  const { execFileSync } = await import('node:child_process')
  execFileSync('npx', ['--yes', 'tsx', 'scripts/swap-offer-seed.ts', 'cancel', seed.nonce], { stdio: ['ignore', 'ignore', 'inherit'] })
  await clickTab('Snapshot')
  await clickTab('Swap')
  await cdp.waitFor(`document.querySelector('.notice .pill')?.textContent === 'taken or cancelled'`, 15000)
  check('cancelled on chain: status flips when the tab is reopened', true)
  check('closed offer offers dismiss', await $(`!![...document.querySelectorAll('.notice button')].find((b) => b.textContent.trim() === 'Dismiss')`))
  await $(`[...document.querySelectorAll('.notice button')].find((b) => b.textContent.trim() === 'Dismiss').click(), true`)
  await sleep(200)
  check('dismiss forgets the offer', await $(`localStorage.getItem(${JSON.stringify(`crumbs.offer.${seed.maker}`)}) === null && !/Your open offer|Offer closed/.test(document.body.textContent)`))
  await import('node:fs').then((fs) => fs.unlinkSync(seedPath))
} else {
  console.log('skip swap restore: run `npx tsx scripts/swap-offer-seed.ts make > ~/.config/crumbs/qol-offer.json` first')
}

// 9. phone: the changelog stacks, the history keeps its two columns
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(400)
await $(`document.querySelector('.history').scrollIntoView({ block: 'center' }), true`)
await sleep(200)
await shot('qol-airdrop-phone')
await $(`location.hash = '#changelog', true`)
await sleep(400)
await shot('qol-changelog-phone')
await $(`history.back(), true`)
await sleep(300)
await cdp.send('Emulation.clearDeviceMetricsOverride')

console.log('--- console ---')
console.log(logs.filter((l) => !/GPU stall|ReadPixels/.test(l)).join('\n') || '(clean)')
console.log(fails ? `${fails} check(s) FAILED` : 'all checks passed')
cdp.close()
process.exit(fails ? 1 : 0)
