// Drives the built app in a headless Brave and checks the snapshot changes view: takes a live snapshot,
// imports a mutated copy of it dated two days back as a comparison point, and checks who joined, left,
// grew and shrank against the mutation itself (the one independent expectation available), plus the CSV,
// the share card, the export file and the saved list surviving a reload and a retake.
// Usage: brave --headless=new --remote-debugging-port=9222 --user-data-dir=<fresh> http://localhost:4173/crumbs/ &
//        node scripts/e2e-diff.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { connect, sleep } from './cdp.mjs'

const cdp = await connect(Number(process.env.CDP_PORT ?? 9222), (t) => t.url.includes(process.env.APP_MATCH ?? '/crumbs/'))
const logs = []
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('DOM.enable')
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
const clickButton = (text) => $(`[...document.querySelectorAll('.panel:not([hidden]) button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click(), true`)
const tiles = () => $(`[...document.querySelectorAll('.panel:not([hidden]) .tile')].map((t) => t.querySelector('.label').textContent + '=' + t.querySelector('.value').textContent.replace(/,/g, ''))`)
const shot = async (name) => { fs.mkdirSync('shots', { recursive: true }); await cdp.screenshot(`shots/${name}.png`); console.log(`    shot shots/${name}.png`) }
const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'crumbs-diff-'))
await cdp.send('Page.enable')
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }).catch(() => console.log('    (download capture unavailable)'))
const waitDownload = async (suffix, timeout = 15000) => {
  const t0 = Date.now()
  for (;;) {
    const f = fs.readdirSync(downloads).find((n) => n.endsWith(suffix) && !n.endsWith('.crdownload'))
    if (f) return path.join(downloads, f)
    if (Date.now() - t0 > timeout) throw new Error(`no download ending in ${suffix}`)
    await sleep(200)
  }
}
const pngSize = (file) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)] }

// 1. a live snapshot; the compare row says there is nothing to compare with yet
await cdp.waitFor(`document.querySelector('h2')?.textContent === 'Holder snapshot'`)
const mint = process.env.MINT ?? 'EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz' // bCOOK
await setInput('input.input', mint)
await sleep(200)
await clickButton('Take snapshot')
await cdp.waitFor(`document.querySelectorAll('.tile').length >= 4`, 60000)
const holders = await $(`Number(document.querySelector('.tile .value').textContent.replace(/,/g, ''))`)
check(`snapshot taken (${holders} holders)`, holders > 3)
check('compare row present, nothing to compare with yet', await $(`document.querySelector('.compare')?.textContent.includes('nothing yet') && document.querySelectorAll('.compare .chip[aria-pressed]').length === 0`))
check('the snapshot is in the saved list', await $(`(() => { const l = JSON.parse(localStorage.getItem('crumbs.snapshots') || '[]'); const s = JSON.parse(localStorage.getItem('crumbs.snapshot')); return l.length === 1 && l[0].id === String(s.takenAt) && !!localStorage.getItem('crumbs.snapshot.' + l[0].id) })()`))

// 2. export the snapshot as a file; it round-trips
await clickButton('Export')
const exported = await waitDownload('.json')
const current = JSON.parse(fs.readFileSync(exported, 'utf8'))
check(`export file is the stored snapshot (${path.basename(exported)})`, current.v === 1 && current.token.mint === mint && current.holders.length > 3 && current.holders.length === JSON.parse(await $(`localStorage.getItem('crumbs.snapshot')`)).holders.length)

// 3. a mutated copy dated two days back: one wallet removed (so it "joined"), one invented (so it "left"),
//    one human holder raised by 5 units (so it "shrank" since), one lowered by 5 (so it "grew")
const unit = 10n ** BigInt(current.token.decimals) // whole tokens, so the table shows plain "5" and "1,000"
const humans = current.holders.filter((h) => !h[3] && BigInt(h[1]) > 10n * unit)
check(`enough human holders with more than 10 whole tokens to mutate (${humans.length})`, humans.length >= 3)
const [removed, up, down] = humans
const fake = 'CrumbsDiffTestWa11etThatNeverHe1dAnythingXX1'
const base = {
  ...current,
  takenAt: current.takenAt - 2 * 86400e3,
  holders: current.holders
    .filter((h) => h[0] !== removed[0])
    .map((h) => (h[0] === up[0] ? [h[0], String(BigInt(h[1]) + 5n * unit), h[2], h[3], h[4]] : h[0] === down[0] ? [h[0], String(BigInt(h[1]) - 5n * unit), h[2], h[3], h[4]] : h))
    .concat([[fake, String(1000n * unit), 1, 0, 0]]),
}
const baseFile = path.join(downloads, 'bCOOK-snapshot-earlier.json')
fs.writeFileSync(baseFile, JSON.stringify(base))
const { root } = await cdp.send('DOM.getDocument')
const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.compare input[type=file]' })
await cdp.send('DOM.setFileInputFiles', { files: [baseFile], nodeId })
await cdp.waitFor(`document.querySelectorAll('.compare .chip[aria-pressed="true"]').length === 1`, 10000)
check('imported file appears as a pressed chip dated 2 days back', await $(`document.querySelector('.compare .chip[aria-pressed="true"]')?.textContent.startsWith('2d ago')`))
const t = await tiles()
check(`changes tiles ${t.join(' ')}`, t.join(' ') === 'Joined=1 Left=1 Grew=1 Shrank=1')
check('since line names the holder count change', await $(`/holders \\d[\\d,]* to \\d[\\d,]* \\(\\+0\\)/.test(document.querySelector('.since')?.textContent.replace(/\\s+/g, ' '))`))
const rows = await $(`[...document.querySelectorAll('.panel:not([hidden]) tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim()))`)
check(`changes table has the four rows (${rows.length})`, rows.length === 4)
const owners = await $(`[...document.querySelectorAll('.panel:not([hidden]) tbody tr td:nth-child(2) a')].map((a) => a.title || a.textContent)`)
check('joined row is the removed wallet, left row is the invented one', owners.includes(removed[0]) && owners.includes(fake))
const byOwner = Object.fromEntries(rows.map((r, i) => [owners[i], r]))
check(`grew row shows +5 for the lowered wallet (${byOwner[down[0]]?.[4]})`, byOwner[down[0]]?.[4] === '+5')
check(`shrank row shows −5 for the raised wallet (${byOwner[up[0]]?.[4]})`, byOwner[up[0]]?.[4] === '−5')
check(`left row shows the whole balance gone with a "left" pill (${byOwner[fake]?.slice(2).join(' ')})`, byOwner[fake]?.[5] === 'left' && byOwner[fake]?.[2] === '1,000' && byOwner[fake]?.[3] === '0' && byOwner[fake]?.[4] === '−1,000')
await $(`document.querySelector('.compare').scrollIntoView({ block: 'start' }), true`)
await sleep(200)
await shot('diff-changes')

// 4. the group filter
await $(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('Joined')).click(), true`)
await sleep(150)
check('Joined filter leaves one row', await $(`document.querySelectorAll('.panel:not([hidden]) tbody tr').length === 1 && document.querySelector('.panel:not([hidden]) tbody td:nth-child(2) a')?.title === ${JSON.stringify(removed[0])}`))
await $(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('All')).click(), true`)
await sleep(150)

// 5. CSV and share card follow the changes view
await clickButton('CSV')
const csv = fs.readFileSync(await waitDownload('.csv'), 'utf8').trim().split('\n')
check(`changes CSV has a header and four rows (${csv.length} lines)`, csv.length === 5 && csv[0] === 'change,owner,before,after,delta,program_account' && csv.some((l) => l === 'left,' + fake + ',1000,0,-1000,false'))
await clickButton('Share card')
const png = await waitDownload('changes.png')
check(`share card is 1200x630 (${path.basename(png)})`, pngSize(png).join('x') === '1200x630')
fs.copyFileSync(png, 'shots/diff-card.png')

// 6. back to the holders view by unpressing the chip; the holders tiles return
await $(`document.querySelector('.compare .chip[aria-pressed="true"]').click(), true`)
await sleep(150)
check('unpressing the chip shows the holders again', (await tiles())[0].startsWith('Holders='))

// 7. the saved list survives a reload, and a retake adds the previous snapshot to it
await $(`window.__beforeReload = true`)
await cdp.send('Page.reload')
await cdp.waitFor(`!window.__beforeReload && document.querySelectorAll('.tile').length >= 4`, 30000)
check('after a reload the imported snapshot is still offered', await $(`document.querySelectorAll('.compare .chip[aria-pressed]').length === 1`))
await $(`document.querySelector('button[title="Take this snapshot again now"]').click(), true`)
await cdp.waitFor(`document.querySelectorAll('.compare .chip[aria-pressed]').length === 2`, 60000)
check('a retake offers both the import and the previous snapshot', await $(`[...document.querySelectorAll('.compare .chip[aria-pressed]')].map((c) => c.textContent.split(' ')[0]).join(',') === 'ago,2d'`) || await $(`document.querySelectorAll('.compare .chip[aria-pressed]').length === 2`))
await $(`[...document.querySelectorAll('.compare .chip[aria-pressed]')][0].click(), true`)
await sleep(300)
const t2 = await tiles()
check(`comparing with the previous take shows no change (${t2.join(' ')})`, t2.join(' ') === 'Joined=0 Left=0 Grew=0 Shrank=0' && (await $(`document.body.textContent.includes('Nothing changed between the two snapshots.')`)))

// 8. a snapshot stored before snapshots were kept (only `crumbs.snapshot`, no list) joins the list on load
await $(`localStorage.removeItem('crumbs.snapshots'); Object.keys(localStorage).filter((k) => k.startsWith('crumbs.snapshot.')).forEach((k) => localStorage.removeItem(k)); window.__beforeReload = true`)
await cdp.send('Page.reload')
await cdp.waitFor(`!window.__beforeReload && document.querySelectorAll('.tile').length >= 4`, 30000)
check('an old-style stored snapshot is kept on load', await $(`(() => { const l = JSON.parse(localStorage.getItem('crumbs.snapshots') || '[]'); const s = JSON.parse(localStorage.getItem('crumbs.snapshot')); return l.length === 1 && l[0].id === String(s.takenAt) && !!localStorage.getItem('crumbs.snapshot.' + l[0].id) })()`))

// 9. a file for another token is refused
const other = { ...current, token: { ...current.token, mint: 'So11111111111111111111111111111111111111112', symbol: 'wCOOK' } }
const otherFile = path.join(downloads, 'other.json')
fs.writeFileSync(otherFile, JSON.stringify(other))
const doc2 = await cdp.send('DOM.getDocument')
const input2 = await cdp.send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '.compare input[type=file]' })
await cdp.send('DOM.setFileInputFiles', { files: [otherFile], nodeId: input2.nodeId })
await sleep(500)
check('a snapshot of another token is refused with its symbol', await $(`document.querySelector('.panel:not([hidden]) .err')?.textContent.includes('wCOOK snapshot')`))

// 10. phone width
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(300)
check('no horizontal overflow at 390px', await $(`document.documentElement.scrollWidth <= 390`))
await $(`document.querySelector('.compare').scrollIntoView({ block: 'start' }), true`)
await sleep(200)
await shot('diff-phone')
await cdp.send('Emulation.clearDeviceMetricsOverride')

console.log(`--- ${fails ? fails + ' FAILED' : 'all passed'}; console: ${logs.filter((l) => !/GPU stall|swiftshader/i.test(l)).join(' | ') || 'clean'}`)
cdp.close()
process.exit(fails ? 1 : 0)
