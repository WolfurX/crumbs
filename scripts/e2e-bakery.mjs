// Drives the built app in a headless Brave and checks the Clicker bakery: a fake Wallet Standard wallet
// connects as an existing player (read-only, it cannot sign), the game loads that player's bakers
// from the chain, and the bakery canvas sits behind the cookie without taking its clicks, beside it
// on a wide card and on a shelf under it on a phone.
// Usage: brave --headless=new --enable-unsafe-swiftshader --remote-debugging-port=9222 --user-data-dir=/tmp/x http://localhost:4173/crumbs/#clicker &
//        OWNER=<player wallet> node scripts/e2e-bakery.mjs
import { connect, sleep } from './cdp.mjs'

const OWNER = process.env.OWNER ?? 'FcxKQjZVoej6AP4aLd9x6BwrSFg8LCZPbjiLdmL9wgJo'
const cdp = await connect(Number(process.env.CDP_PORT ?? 9222), (t) => t.url.includes(process.env.APP_MATCH ?? '/crumbs/'))
const logs = []
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
cdp.on('Runtime.consoleAPICalled', (p) => logs.push(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`))
cdp.on('Runtime.exceptionThrown', (p) => logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`))

let fails = 0
const $ = (expr) => cdp.evaluate(expr)
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) fails++ }
const shot = async (name) => { await cdp.screenshot(`shots/${name}.png`); console.log(`    shot shots/${name}.png`) }
const size = async (width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await sleep(800)
}

await size(1280, 1000)
await $(`location.hash = '#clicker', true`)
await $(`(() => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const unb58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n } for (const c of s) { if (c === '1') out.unshift(0); else break } return new Uint8Array(out) };
  const account = { address: ${JSON.stringify(OWNER)}, publicKey: unb58(${JSON.stringify(OWNER)}), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
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
await cdp.waitFor(`!!document.querySelector('.bakery3d canvas')`, 30000)
await sleep(2500) // the chunk, the first layout and a few frames of idle motion

const owned = await $(`[...document.querySelectorAll('.baker')].map((b) => Number(b.querySelector('.pill')?.textContent ?? 0))`)
console.log(`player ${OWNER.slice(0, 4)} owns ${JSON.stringify(owned)}`)
const layout = () => $(`(() => {
  const stage = document.querySelector('.bakery-stage').getBoundingClientRect();
  const wrap = document.querySelector('.cookie-wrap').getBoundingClientRect();
  const canvas = document.querySelector('.bakery3d canvas').getBoundingClientRect();
  const hit = document.elementFromPoint(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
  return { stageW: stage.width, stageH: stage.height, wrapW: wrap.width, wrapH: wrap.height, canvasH: canvas.height, cookieGetsClick: !!hit?.closest('.cookie-btn') }
})()`)

let l = await layout()
console.log(`    wide: ${JSON.stringify(l)}`)
check('wide card: bakers beside the cookie, stage as tall as the cookie', l.stageW >= 540 && Math.abs(l.stageH - l.wrapH) < 2 && Math.abs(l.canvasH - l.stageH) < 2)
check('the cookie still gets the click through the bakery', l.cookieGetsClick)
await $(`document.querySelector('.bakery-stage').scrollIntoView({ block: 'center' }), true`)
await sleep(600)
await shot('bakery-wide')

await size(390, 900)
await $(`document.querySelector('.bakery-stage').scrollIntoView({ block: 'center' }), true`)
await sleep(1200)
l = await layout()
console.log(`    phone: ${JSON.stringify(l)}`)
check('phone: a 150px shelf under the cookie', l.stageW < 540 && Math.abs(l.stageH - l.wrapH - 150) < 2 && Math.abs(l.canvasH - l.stageH) < 2)
check('phone: the cookie still gets the click', l.cookieGetsClick)
await shot('bakery-phone')

console.log(`--- ${fails ? `${fails} failed` : 'all passed'} ---`)
const noise = /Automatic fallback to software WebGL|GPU stall due to ReadPixels|WalletNotSelectedError|beforeinstallprompt/
console.log(logs.filter((x) => !noise.test(x)).join('\n') || '(console clean)')
await cdp.send('Emulation.clearDeviceMetricsOverride')
cdp.close()
process.exit(fails ? 1 : 0)
