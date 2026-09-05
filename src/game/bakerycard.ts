import { TIER_NAMES } from './constants'
import type { PlayerState } from './codec'

const W = 1200, H = 630

/** "My bakery" share image, same palette as the snapshot card. */
export async function renderBakeryCard(p: PlayerState, opts: { owner: string; rank: number | null; players: number; site: string; cookiesText: string; cpsText: string }): Promise<Blob> {
  await document.fonts.ready.catch(() => {})
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  const display = '"Space Grotesk", system-ui, sans-serif', body = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', mono = 'ui-monospace, Menlo, Consolas, monospace'
  ctx.fillStyle = '#12100c'; ctx.fillRect(0, 0, W, H)
  // cookie mark
  ctx.fillStyle = '#e0a54a'; ctx.beginPath(); ctx.arc(74, 70, 18, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#12100c'
  for (const [dx, dy, r] of [[-6, -6, 2.6], [6, -8, 2.2], [7, 4, 2.8], [-3, 7, 2.1]]) { ctx.beginPath(); ctx.arc(74 + dx, 70 + dy, r, 0, Math.PI * 2); ctx.fill() }
  ctx.fillStyle = '#ece6da'; ctx.font = `600 26px ${display}`; ctx.textBaseline = 'middle'; ctx.fillText('Crumbs', 104, 70)
  ctx.fillStyle = '#877f73'; ctx.font = `400 22px ${body}`; ctx.fillText('my bakery on Cookie Chain', 208, 71)
  ctx.textAlign = 'right'; ctx.fillText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), W - 60, 71); ctx.textAlign = 'left'
  // big number
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ece6da'; ctx.font = `700 96px ${display}`; ctx.fillText(opts.cookiesText, 60, 220)
  ctx.fillStyle = '#877f73'; ctx.font = `400 26px ${body}`; ctx.fillText(`cookies baked · ${opts.cpsText} per second · ${Number(p.lifetimeClicks).toLocaleString('en-US')} clicks, every one a transaction`, 60, 262)
  ctx.font = `400 20px ${mono}`; ctx.fillText(opts.owner, 60, 296)
  // bakers grid
  const owned = p.owned.map((n, i) => ({ n, name: TIER_NAMES[i] })).filter((x) => x.n > 0)
  const cols = 4, cw = (W - 120) / cols, y0 = 340
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1
  const rows = Math.max(1, Math.ceil(Math.max(owned.length, 1) / cols))
  ctx.strokeRect(60.5, y0 + 0.5, W - 120 - 1, rows * 84)
  if (!owned.length) { ctx.fillStyle = '#877f73'; ctx.font = `400 22px ${body}`; ctx.fillText('No bakers yet. Just clicks.', 80, y0 + 50) }
  owned.forEach((b, i) => {
    const x = 60 + (i % cols) * cw, y = y0 + Math.floor(i / cols) * 84
    if (i % cols) { ctx.beginPath(); ctx.moveTo(x + 0.5, y); ctx.lineTo(x + 0.5, y + 84); ctx.stroke() }
    if (i >= cols) { ctx.beginPath(); ctx.moveTo(x, y + 0.5); ctx.lineTo(x + cw, y + 0.5); ctx.stroke() }
    ctx.fillStyle = '#877f73'; ctx.font = `400 18px ${body}`; ctx.fillText(b.name, x + 20, y + 32)
    ctx.fillStyle = '#ece6da'; ctx.font = `600 34px ${display}`; ctx.fillText(String(b.n), x + 20, y + 68)
  })
  // footer
  ctx.fillStyle = '#877f73'; ctx.font = `400 18px ${body}`
  ctx.fillText(opts.site, 60, H - 34)
  ctx.textAlign = 'right'
  ctx.fillText(opts.rank ? `#${opts.rank} of ${opts.players} players` : `${opts.players} players`, W - 60, H - 34)
  ctx.textAlign = 'left'
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
}
