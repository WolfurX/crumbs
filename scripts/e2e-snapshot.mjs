// Drives the built app in a headless Brave: takes a bCOOK snapshot and checks the numbers appear.
// Usage: brave --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/x http://localhost:4173/crumbs/ &
//        node scripts/e2e-snapshot.mjs
import { connect, sleep } from './cdp.mjs'

const cdp = await connect(Number(process.env.CDP_PORT ?? 9222), (t) => t.url.includes(process.env.APP_MATCH ?? '/crumbs/'))
const logs = []
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
cdp.on('Runtime.consoleAPICalled', (p) => logs.push(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`))
cdp.on('Runtime.exceptionThrown', (p) => logs.push(`[exception] ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`))
cdp.on('Log.entryAdded', (p) => logs.push(`[${p.entry.level}] ${p.entry.text}`))

await cdp.waitFor(`document.querySelector('h2')?.textContent === 'Holder snapshot'`)
const mint = process.env.MINT ?? 'EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz' // bCOOK
await cdp.evaluate(`(() => {
  const el = document.querySelector('input.input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(mint)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`)
await sleep(300)
await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Take snapshot').click(), true`)
await cdp.waitFor(`document.querySelectorAll('.tile').length >= 4`, 60000)
const tiles = await cdp.evaluate(`[...document.querySelectorAll('.tile')].map(t => t.querySelector('.label').textContent + ' = ' + t.querySelector('.value').textContent)`)
const rows = await cdp.evaluate(`document.querySelectorAll('tbody tr').length`)
const bars = await cdp.evaluate(`document.querySelectorAll('.bar-row').length`)
console.log(tiles.join('\n'))
console.log(`table rows: ${rows}, bars: ${bars}`)
await cdp.screenshot(process.env.SHOT ?? 'snapshot.png')
console.log('--- console ---')
console.log(logs.join('\n') || '(clean)')
cdp.close()
