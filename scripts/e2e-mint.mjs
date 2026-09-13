// Drives a real quick drop through the Nightly test profile: connect, form, two approvals, done.
// Usage: crumb-wallet http://localhost:4173/crumbs/   (CDP port 9223, wallet FcxK on Cookie Chain)
//        node scripts/e2e-mint.mjs
import { readFileSync } from 'node:fs'
import { attach, connect, sleep } from './cdp.mjs'

const PORT = Number(process.env.CDP_PORT ?? 9223)
const APP = process.env.APP_MATCH ?? '/crumbs/'
const COUNT = Number(process.env.COUNT ?? 3)
const SHOT = process.env.SHOT ?? 'mint-done.png'
const creds = JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/nightly-wallet.json`, 'utf8'))
const password = creds.password ?? creds.pass ?? creds.pw
const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a)

async function nightlyWindow(timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const t = (await list()).find((x) => x.type === 'page' && x.url.startsWith('chrome-extension://') && /options\.html/.test(x.url))
    if (t) return attach(t.webSocketDebuggerUrl)
    await sleep(300)
  }
  throw new Error('no Nightly approval window appeared')
}

/** Unlock if asked, then press the first button matching one of the patterns. */
async function approve(patterns, timeout = 40000) {
  const win = await nightlyWindow()
  const start = Date.now()
  try {
    while (Date.now() - start < timeout) {
      const state = await win.evaluate(`JSON.stringify({ pw: document.querySelectorAll('input[type=password]').length, btns: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean) })`).catch(() => null)
      if (!state) { await sleep(300); continue }
      const { pw, btns } = JSON.parse(state)
      if (pw) {
        // Nightly's password field ignores synthetic input events; type it with real key events
        await win.send('Page.bringToFront')
        await win.evaluate(`(() => { const el = document.querySelector('input[type=password]'); el.focus(); el.select(); return true })()`)
        await win.send('Input.insertText', { text: password })
        await win.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await win.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        log('nightly: unlock typed')
        await sleep(1200)
        continue
      }
      const hit = btns.find((b) => patterns.some((p) => p.test(b)))
      if (hit) {
        await win.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(hit)}).click(), true`)
        log(`nightly: pressed "${hit}" (buttons were: ${btns.join(' | ')})`)
        return hit
      }
      await sleep(300)
    }
    throw new Error('no matching button in the Nightly window')
  } finally {
    win.close()
  }
}

const app = await connect(PORT, (t) => t.url.includes(APP))
const logs = []
await app.send('Runtime.enable')
app.on('Runtime.exceptionThrown', (p) => logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`))
await app.send('Page.bringToFront')
await app.send('Page.reload', { ignoreCache: true })
await sleep(2500)
await app.waitFor(`!!document.querySelector('.tabs')`)

// 1. connect Nightly unless already connected
const connected = await app.evaluate(`!!document.querySelector('.wallet')?.textContent.includes('FcxK')`)
if (!connected) {
  await app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Connect wallet')).click(), true`)
  await sleep(500)
  const picked = await app.evaluate(`(() => { const b = [...document.querySelectorAll('.menu button')].find(b => /nightly/i.test(b.textContent)); b?.click(); return b?.textContent.trim() })()`)
  log('picked wallet:', picked)
  await approve([/connect/i])
  await app.waitFor(`!!document.querySelector('.wallet')?.textContent.includes('FcxK')`, 30000)
}
log('wallet connected')

// 2. the form
await app.evaluate(`[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Mint NFT')).click(), true`)
await app.waitFor(`!!document.querySelector('.dropzone input[type=file]') || !!document.querySelector('.mint')`)
await app.evaluate(`(async () => {
  const pending = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Discard'); pending?.click();
  await new Promise(r => setTimeout(r, 300));
  const c = document.createElement('canvas'); c.width = 1400; c.height = 1400; const x = c.getContext('2d');
  x.fillStyle = '#1a1712'; x.fillRect(0, 0, 1400, 1400);
  x.fillStyle = '#e0a54a'; x.beginPath(); x.arc(700, 700, 520, 0, 7); x.fill();
  x.fillStyle = '#12100c'; for (const [dx, dy] of [[-180, -140], [120, -200], [220, 90], [-90, 160], [-260, 40], [30, 20]]) { x.beginPath(); x.arc(700 + dx, 700 + dy, 62, 0, 7); x.fill(); }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'nightly-cookie.png', { type: 'image/png' });
  const input = document.querySelector('.dropzone input[type=file]');
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
  set(document.querySelector('.mint input[placeholder="Cookie Club Pass"]'), 'Nightly Test Cookie');
  set(document.querySelector('.mint input.num'), ${COUNT});
  return true })()`)
await app.waitFor(`document.body.textContent.includes('Looks good')`, 15000)
await app.waitFor(`(() => { const b = [...document.querySelectorAll('.mint button.primary')].find(b => b.textContent.startsWith('Mint')); return b && !b.disabled })()`, 15000)
const cost = await app.evaluate(`document.querySelector('.costbox')?.textContent`)
log('form ready, cost box:', cost)
await app.evaluate(`[...document.querySelectorAll('.mint button.primary')].find(b => b.textContent.startsWith('Mint')).click(), true`)
await app.waitFor(`!!document.querySelector('.sheet')`)
log('confirm sheet:', await app.evaluate(`document.querySelector('.sheet').textContent`))
await app.evaluate(`[...document.querySelectorAll('.sheet button')].find(b => b.textContent.includes('Yes, mint')).click(), true`)

// 3. the one approval, then wait: Nightly opens one window per transaction, so keep pressing
//    Approve while windows appear (the engine only asks once; extra presses hit nothing)
{
  const start = Date.now()
  let presses = 0
  while (Date.now() - start < 240000) {
    if (await app.evaluate(`document.querySelector('h2')?.textContent.startsWith('Done')`).catch(() => false)) break
    const stopped = await app.evaluate(`document.body.textContent.includes('Stopped:')`).catch(() => false)
    if (stopped) { log('STOPPED:', await app.evaluate(`document.querySelector('.sheet')?.textContent`)); break }
    const t = (await list()).find((x) => x.type === 'page' && x.url.startsWith('chrome-extension://') && /options\.html/.test(x.url))
    if (t) {
      const w = attach(t.webSocketDebuggerUrl)
      const st = JSON.parse(await w.evaluate(`JSON.stringify({ pw: document.querySelectorAll('input[type=password]').length, btns: [...document.querySelectorAll('button')].map(b => b.textContent.trim()) })`).catch(() => '{"pw":0,"btns":[]}'))
      if (st.pw) {
        await w.send('Page.bringToFront')
        await w.evaluate(`(() => { const el = document.querySelector('input[type=password]'); el.focus(); el.select(); return true })()`)
        await w.send('Input.insertText', { text: password })
        await w.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await w.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        log('nightly: unlock typed')
        await sleep(1200)
      } else if (st.btns.includes('Approve')) {
        const prompt = await app.evaluate(`document.querySelector('.sheet')?.textContent`).catch(() => '')
        await w.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Approve').click(), true`)
        presses++
        log(`nightly: pressed Approve #${presses} for: ${prompt}`)
        await sleep(1500)
      }
      w.close()
    }
    await sleep(400)
  }
  log(`wallet approvals pressed: ${presses}`)
}

// 4. done
await app.waitFor(`document.querySelector('h2')?.textContent.startsWith('Done')`, 240000)
log('DONE:', await app.evaluate(`document.querySelector('h2').textContent`))
const state = JSON.parse(await app.evaluate(`localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('crumbs.drop')))`))
console.log('collection', state.collection.mint)
console.log('pieces', state.pieces.map((p) => p.mint).join(' '))
console.log('image blob', state.imageBlob.pubkey)
await app.screenshot(SHOT)
console.log('--- exceptions ---')
console.log(logs.join('\n') || '(none)')
app.close()
process.exit(0)
