import type { Holder } from './das'
import { fmtAmount, fmtInt, fmtPct, shortAddr } from './format'

export interface CardInput {
  symbol: string
  name: string
  mint: string
  holders: Holder[]
  held: bigint
  decimals: number
  top10Pct: number
  poolsPct: number
  takenAt: number
  site: string
}

const W = 1200
const H = 630

/** Renders the snapshot as a 1200x630 image for X and Telegram. Same palette as the app. */
export async function renderShareCard(c: CardInput): Promise<Blob> {
  await document.fonts.ready.catch(() => {})
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const display = '"Space Grotesk", system-ui, sans-serif'
  const body = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  const mono = 'ui-monospace, Menlo, Consolas, monospace'

  ctx.fillStyle = '#12100c'
  ctx.fillRect(0, 0, W, H)

  // brand
  ctx.fillStyle = '#e0a54a'
  ctx.beginPath()
  ctx.arc(74, 70, 18, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#12100c'
  for (const [dx, dy, r] of [[-6, -6, 2.6], [6, -8, 2.2], [7, 4, 2.8], [-3, 7, 2.1]]) {
    ctx.beginPath()
    ctx.arc(74 + dx, 70 + dy, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#ece6da'
  ctx.font = `600 26px ${display}`
  ctx.textBaseline = 'middle'
  ctx.fillText('Crumbs', 104, 70)
  ctx.fillStyle = '#877f73'
  ctx.font = `400 22px ${body}`
  ctx.fillText('holder snapshot on Cookie Chain', 208, 71)
  ctx.textAlign = 'right'
  ctx.fillText(new Date(c.takenAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), W - 60, 71)
  ctx.textAlign = 'left'

  // token
  ctx.fillStyle = '#ece6da'
  ctx.font = `700 64px ${display}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(c.symbol, 60, 176)
  const symW = ctx.measureText(c.symbol).width
  ctx.fillStyle = '#877f73'
  ctx.font = `400 26px ${body}`
  ctx.fillText(c.name, 60 + symW + 22, 176)
  ctx.font = `400 20px ${mono}`
  ctx.fillText(shortAddr(c.mint, 8, 8), 60, 210)

  // tiles
  const tiles: [string, string][] = [
    ['Holders', fmtInt(c.holders.length)],
    ['Held by them', fmtAmount(c.held, c.decimals, true)],
    ['Top 10 share', fmtPct(c.top10Pct)],
    ['In pools and vaults', fmtPct(c.poolsPct)],
  ]
  const tx0 = 60
  const ty0 = 250
  const tw = (W - 120) / 4
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.strokeRect(tx0 + 0.5, ty0 + 0.5, W - 120 - 1, 96)
  tiles.forEach(([label, value], i) => {
    const x = tx0 + i * tw
    if (i) {
      ctx.beginPath()
      ctx.moveTo(x + 0.5, ty0)
      ctx.lineTo(x + 0.5, ty0 + 96)
      ctx.stroke()
    }
    ctx.fillStyle = '#877f73'
    ctx.font = `400 18px ${body}`
    ctx.fillText(label, x + 20, ty0 + 34)
    ctx.fillStyle = '#ece6da'
    ctx.font = `600 34px ${display}`
    ctx.fillText(value, x + 20, ty0 + 76)
  })

  // top holders bars
  const top = c.holders.slice(0, 5)
  const rest = c.holders.slice(5).reduce((n, h) => n + h.amount, 0n)
  const rows = top.map((h) => ({ label: shortAddr(h.owner, 4, 4), pct: c.held ? Number((h.amount * 100000n) / c.held) / 1000 : 0, other: false }))
  if (rest > 0n) rows.push({ label: `${c.holders.length - 5} others`, pct: c.held ? Number((rest * 100000n) / c.held) / 1000 : 0, other: true })
  const max = Math.max(...rows.map((r) => r.pct), 1)
  const by0 = 380
  const rowH = 30
  const labelW = 120
  const barX = 60 + labelW
  const barW = W - 120 - labelW - 90
  rows.forEach((r, i) => {
    const y = by0 + i * rowH
    ctx.fillStyle = '#b9b1a4'
    ctx.font = `400 17px ${mono}`
    ctx.textBaseline = 'middle'
    ctx.fillText(r.label, 60, y + 10)
    const w = Math.max(3, (r.pct / max) * barW)
    ctx.fillStyle = r.other ? 'rgba(255,255,255,0.18)' : '#e0a54a'
    roundRect(ctx, barX, y, w, 18, [0, 4, 4, 0])
    ctx.fill()
    ctx.fillStyle = '#b9b1a4'
    ctx.font = `400 17px ${body}`
    ctx.textAlign = 'right'
    ctx.fillText(fmtPct(r.pct), W - 60, y + 10)
    ctx.textAlign = 'left'
  })

  // footer
  ctx.fillStyle = '#877f73'
  ctx.font = `400 18px ${body}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(c.site, 60, H - 30)
  ctx.textAlign = 'right'
  ctx.fillText('Pools, vaults and escrows excluded', W - 60, H - 30)
  ctx.textAlign = 'left'

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  const [tl, tr, br, bl] = r
  ctx.beginPath()
  ctx.moveTo(x + tl, y)
  ctx.lineTo(x + w - tr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr)
  ctx.lineTo(x + w, y + h - br)
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h)
  ctx.lineTo(x + bl, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl)
  ctx.lineTo(x, y + tl)
  ctx.quadraticCurveTo(x, y, x + tl, y)
  ctx.closePath()
}
