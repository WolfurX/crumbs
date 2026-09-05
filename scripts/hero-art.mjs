// Draws the hero illustration once and emits public/hero.svg (animated, used in the page) and
// public/og.png (1200x630 with the wordmark, for link previews). Run: node scripts/hero-art.mjs
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const A = '#e0a54a' // accent
const L = '#3a342b' // hairline on the dark ground
const M = '#877f73' // muted ink
const BG = '#12100c'

function cookie(x, y, r) {
  const chips = [[-0.35, -0.3, 0.14], [0.3, -0.42, 0.11], [0.42, 0.22, 0.15], [-0.1, 0.45, 0.12], [-0.5, 0.2, 0.1], [0.05, -0.02, 0.1]]
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${A}" stroke-width="2"/>` +
    chips.map(([dx, dy, dr]) => `<circle cx="${(x + dx * r).toFixed(1)}" cy="${(y + dy * r).toFixed(1)}" r="${(dr * r).toFixed(1)}" fill="${A}" opacity="0.9"/>`).join('')
}
const crumb = (x, y, r, delay) => `<circle class="c" cx="${x}" cy="${y}" r="${r}" fill="${A}" style="animation-delay:${delay}s"/>`
const holder = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r + 6}" fill="none" stroke="${L}" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="${r}" fill="${M}"/>`
const wallet = (x, y) => `<rect x="${x - 26}" y="${y}" width="52" height="32" rx="5" fill="none" stroke="${L}" stroke-width="1.5"/><path d="M${x - 26} ${y + 11} H${x + 26}" stroke="${L}" stroke-width="1.5"/><circle cx="${x + 15}" cy="${y + 22}" r="2.5" fill="${M}"/>`
const parachute = (x, y, delay) => `<g class="f" style="animation-delay:${delay}s"><path d="M${x - 28} ${y + 20} A28 28 0 0 1 ${x + 28} ${y + 20} Z" fill="none" stroke="${A}" stroke-width="2"/><path d="M${x - 28} ${y + 20} L${x} ${y + 52} L${x + 28} ${y + 20} M${x - 10} ${y + 20} L${x} ${y + 52} L${x + 10} ${y + 20}" stroke="${L}" stroke-width="1.5" fill="none"/><rect x="${x - 5}" y="${y + 52}" width="10" height="10" rx="2" fill="${A}"/></g>`

// 480x270 scene: the cookie under a lens on the left, a crumb trail splitting toward holders
// (snapshot), a parachute over a wallet (airdrop) and a broom with a dustpan (cleanup).
const scene = `
  <circle cx="118" cy="138" r="94" fill="none" stroke="${L}" stroke-width="1.5" stroke-dasharray="3 8"/>
  ${cookie(118, 138, 66)}
  <path d="M188 112 C 240 92, 280 70, 340 58" stroke="${L}" stroke-width="1.5" fill="none"/>
  <path d="M190 140 C 250 140, 290 150, 336 172" stroke="${L}" stroke-width="1.5" fill="none"/>
  <path d="M182 170 C 230 196, 270 224, 328 236" stroke="${L}" stroke-width="1.5" fill="none"/>
  ${holder(360, 44, 5)}${holder(398, 66, 4)}${holder(432, 40, 6)}${holder(436, 86, 4)}${holder(394, 108, 3)}
  ${parachute(392, 100, 0.8)}
  ${wallet(392, 176)}
  <path d="M440 190 L392 246" stroke="${A}" stroke-width="2"/>
  <path d="M392 246 L376 238 L366 262 L400 264 Z" fill="none" stroke="${A}" stroke-width="1.5"/>
  <path d="M312 254 H346 V264 H306 A5 5 0 0 1 301 259 V258 A4 4 0 0 1 305 254 Z" fill="none" stroke="${L}" stroke-width="1.5"/>
  ${crumb(206, 104, 2.4, 0)}${crumb(236, 90, 2, 1.1)}${crumb(272, 76, 1.8, 2.2)}
  ${crumb(224, 142, 2.2, 0.6)}${crumb(262, 146, 1.8, 1.7)}${crumb(300, 158, 1.6, 2.8)}
  ${crumb(216, 186, 2.2, 0.3)}${crumb(252, 210, 1.9, 1.4)}${crumb(324, 258, 2, 2.5)}${crumb(336, 260, 1.6, 0.9)}
  ${crumb(60, 232, 2.2, 1.9)}${crumb(150, 34, 1.8, 0.4)}
`
const style = `<style>
  .c, .f { animation: drift 5.5s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: center; }
  @keyframes drift { from { transform: translateY(-3px); } to { transform: translateY(3px); } }
  @media (prefers-reduced-motion: reduce) { .c, .f { animation: none; } }
</style>`

const hero = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270" role="img" aria-label="A cookie under a lens, crumbs travelling to holders, a parachute over a wallet and a broom sweeping">${style}${scene}</svg>`
writeFileSync(new URL('../public/hero.svg', import.meta.url), hero)

// OG frame: dark ground, scene on the right, wordmark and line on the left. Text uses whatever
// sans fontconfig resolves; the page itself uses Space Grotesk.
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <g transform="translate(560 120) scale(1.2)">${scene}</g>
  <g transform="translate(72 88)">
    <circle cx="20" cy="20" r="20" fill="${A}"/>
    <circle cx="13" cy="15" r="2.9" fill="${BG}"/><circle cx="24" cy="12" r="2.4" fill="${BG}"/><circle cx="27" cy="25" r="3.1" fill="${BG}"/><circle cx="16" cy="27" r="2.3" fill="${BG}"/>
    <text x="54" y="30" font-family="Carlito, 'Space Grotesk', system-ui, sans-serif" font-weight="700" font-size="34" fill="#ece6da">Crumbs</text>
  </g>
  <text x="72" y="300" font-family="Carlito, 'Space Grotesk', system-ui, sans-serif" font-weight="700" font-size="60" fill="#ece6da">The utility app</text>
  <text x="72" y="368" font-family="Carlito, 'Space Grotesk', system-ui, sans-serif" font-weight="700" font-size="60" fill="#ece6da">for Cookie Chain.</text>
  <text x="72" y="428" font-family="Carlito, system-ui, sans-serif" font-size="26" fill="#b9b1a4">Snapshot holders, airdrop tokens, tidy your wallet.</text>
  <text x="72" y="466" font-family="Carlito, system-ui, sans-serif" font-size="26" fill="#b9b1a4">In your browser, no fees.</text>
  <text x="72" y="560" font-family="Carlito, system-ui, sans-serif" font-size="22" fill="${M}">crumbs-cookie.vercel.app</text>
</svg>`
const ogPath = new URL('../scripts/og.svg', import.meta.url)
writeFileSync(ogPath, og)
execFileSync('rsvg-convert', ['-w', '1200', '-h', '630', ogPath.pathname, '-o', new URL('../public/og.png', import.meta.url).pathname])
console.log('wrote public/hero.svg and public/og.png')
