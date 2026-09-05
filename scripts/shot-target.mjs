// Screenshot + DOM text of one CDP target: node scripts/shot-target.mjs <port> <url-substring> <out.png>
import { connect } from './cdp.mjs'
const [port, needle, out] = process.argv.slice(2)
const cdp = await connect(Number(port), (t) => t.url.includes(needle))
await cdp.send('Page.enable')
await new Promise((r) => setTimeout(r, 800))
const text = await cdp.evaluate(`document.body.innerText.slice(0, 1500)`)
const buttons = await cdp.evaluate(`[...document.querySelectorAll('button, a, input')].map(b => (b.tagName + ':' + (b.textContent.trim() || b.placeholder || b.type || '').slice(0, 40))).filter(Boolean).slice(0, 40)`)
await cdp.screenshot(out)
console.log(text); console.log('--- controls ---'); console.log(buttons.join('\n'))
cdp.close()
