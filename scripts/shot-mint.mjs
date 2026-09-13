// Production screenshot of the Mint NFT tab in its ready state, through the Nightly profile (CDP 9223).
// Usage: crumb-wallet https://crumbs-cookie.vercel.app/ ; node scripts/shot-mint.mjs out.png
import { readFileSync } from 'node:fs'
import { attach, connect, sleep } from './cdp.mjs'
const OUT = process.argv[2] ?? 'mint.png'
const password = JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/nightly-wallet.json`, 'utf8')).password
const list = async () => (await fetch('http://127.0.0.1:9223/json/list')).json()
const app = await connect(9223, (t) => t.url.startsWith('https://crumbs-cookie.vercel.app'))
await app.send('Page.bringToFront')
await app.send('Page.reload', { ignoreCache: true })
await sleep(3000)
await app.waitFor(`!!document.querySelector('.tabs')`)
await sleep(1500)
if (!(await app.evaluate(`!!document.querySelector('.wallet')?.textContent.includes('FcxK')`))) {
  await app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Connect wallet')).click(), true`)
  await sleep(500)
  await app.evaluate(`[...document.querySelectorAll('.menu button')].find(b => /nightly/i.test(b.textContent))?.click(), true`)
  const start = Date.now()
  while (Date.now() - start < 40000 && !(await app.evaluate(`!!document.querySelector('.wallet')?.textContent.includes('FcxK')`))) {
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
        await sleep(1200)
      } else if (st.btns.includes('Connect')) {
        await w.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Connect').click(), true`)
        await sleep(1200)
      }
      w.close()
    }
    await sleep(400)
  }
  await app.send('Page.bringToFront')
}
console.log('wallet:', await app.evaluate(`document.querySelector('.wallet')?.textContent`))
await app.evaluate(`[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Mint NFT')).click(), true`)
await app.waitFor(`!!document.querySelector('.dropzone input[type=file]')`)
await app.evaluate(`(async () => {
  const c = document.createElement('canvas'); c.width = 1400; c.height = 1400; const x = c.getContext('2d');
  x.fillStyle = '#1a1712'; x.fillRect(0, 0, 1400, 1400);
  x.fillStyle = '#d9a35a'; x.beginPath(); x.arc(700, 700, 540, 0, 7); x.fill();
  x.fillStyle = '#c48f47'; x.beginPath(); x.arc(700, 700, 500, 0, 7); x.fill();
  x.fillStyle = '#d9a35a'; x.beginPath(); x.arc(700, 700, 470, 0, 7); x.fill();
  x.fillStyle = '#2a211a'; for (const [dx, dy, r] of [[-190, -150, 66], [130, -210, 58], [230, 80, 70], [-100, 170, 62], [-280, 30, 54], [40, 10, 60], [150, 290, 50], [-40, -330, 48]]) { x.beginPath(); x.arc(700 + dx, 700 + dy, r, 0, 7); x.fill(); }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'cookie-club-pass.png', { type: 'image/png' });
  const input = document.querySelector('.dropzone input[type=file]');
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
  set(document.querySelector('.mint input[placeholder="Cookie Club Pass"]'), 'Cookie Club Pass');
  set(document.querySelector('.mint input.num'), '250');
  return true })()`)
await app.waitFor(`document.body.textContent.includes('Looks good') && !!document.querySelector('.costbox .total')`, 15000)
await sleep(800)
await app.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await sleep(600)
await app.evaluate(`document.querySelector('.tabs').scrollIntoView({ block: 'start' }); window.scrollBy(0, -16); true`)
await sleep(600)
await app.screenshot(OUT)
await app.send('Emulation.clearDeviceMetricsOverride')
console.log('saved', OUT, await app.evaluate(`document.querySelector('.costbox')?.textContent`))
app.close(); process.exit(0)
