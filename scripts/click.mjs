// node scripts/click.mjs <port> <url-substring> "<button text>" [out.png] : click a control by text, then dump.
import { connect, sleep } from './cdp.mjs'
const [port, needle, text, out] = process.argv.slice(2)
const cdp = await connect(Number(port), (t) => t.url.includes(needle))
const ok = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button, a, [role=button], div[tabindex]')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`)
console.log(ok ? `clicked "${text}"` : `NOT FOUND "${text}"`)
await sleep(1200)
console.log(await cdp.evaluate(`document.body.innerText.slice(0, 1200)`))
console.log('--- controls ---')
console.log((await cdp.evaluate(`[...document.querySelectorAll('button, a, input, textarea')].map(b => b.tagName + ':' + (b.textContent.trim() || b.placeholder || b.type || '').slice(0, 50)).slice(0, 40)`)).join('\n'))
if (out) await cdp.screenshot(out)
cdp.close()
