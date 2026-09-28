import type { Holder } from './das'
import { fmtDelta, type HolderChange } from './diff'
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
  /** An NFT collection: amounts are pieces held. */
  collection?: boolean
  site: string
}

const W = 1200
const H = 630

const DISPLAY = '"Space Grotesk", system-ui, sans-serif'
const BODY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, Menlo, Consolas, monospace'
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

async function card(): Promise<[HTMLCanvasElement, CanvasRenderingContext2D]> {
  await document.fonts.ready.catch(() => {})
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#12100c'
  ctx.fillRect(0, 0, W, H)
  return [canvas, ctx]
}

/** Brand mark, card title and the date on the right. */
function header(ctx: CanvasRenderingContext2D, title: string, date: string) {
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
  ctx.font = `600 26px ${DISPLAY}`
  ctx.textBaseline = 'middle'
  ctx.fillText('Crumbs', 104, 70)
  ctx.fillStyle = '#877f73'
  ctx.font = `400 22px ${BODY}`
  ctx.fillText(title, 208, 71)
  ctx.textAlign = 'right'
  ctx.fillText(date, W - 60, 71)
  ctx.textAlign = 'left'
}

/** Symbol, name and the short mint. */
function tokenLine(ctx: CanvasRenderingContext2D, symbol: string, name: string, mint: string) {
  ctx.fillStyle = '#ece6da'
  ctx.font = `700 64px ${DISPLAY}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(symbol, 60, 176)
  const symW = ctx.measureText(symbol).width
  ctx.fillStyle = '#877f73'
  ctx.font = `400 26px ${BODY}`
  ctx.fillText(name, 60 + symW + 22, 176)
  ctx.font = `400 20px ${MONO}`
  ctx.fillText(shortAddr(mint, 8, 8), 60, 210)
}

/** Four outlined tiles across the card. */
function tiles(ctx: CanvasRenderingContext2D, items: [string, string][], ty0 = 250) {
  const tx0 = 60
  const tw = (W - 120) / items.length
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.lineWidth = 1
  ctx.strokeRect(tx0 + 0.5, ty0 + 0.5, W - 120 - 1, 96)
  items.forEach(([label, value], i) => {
    const x = tx0 + i * tw
    if (i) {
      ctx.beginPath()
      ctx.moveTo(x + 0.5, ty0)
      ctx.lineTo(x + 0.5, ty0 + 96)
      ctx.stroke()
    }
    ctx.fillStyle = '#877f73'
    ctx.font = `400 18px ${BODY}`
    ctx.fillText(label, x + 20, ty0 + 34)
    ctx.fillStyle = '#ece6da'
    ctx.font = `600 34px ${DISPLAY}`
    ctx.fillText(value, x + 20, ty0 + 76)
  })
}

/** Labelled bars with a value on the right; `bar` is the fill 0..1, `color` the fill colour. */
function bars(ctx: CanvasRenderingContext2D, rows: { label: string; bar: number; value: string; color: string }[], by0 = 380) {
  const rowH = 30
  const labelW = 120
  const barX = 60 + labelW
  // the value column is as wide as the widest value, so a long one never sits on its bar
  ctx.font = `400 17px ${BODY}`
  const valueW = Math.max(90, ...rows.map((r) => ctx.measureText(r.value).width + 16))
  const barW = W - 120 - labelW - valueW
  rows.forEach((r, i) => {
    const y = by0 + i * rowH
    ctx.fillStyle = '#b9b1a4'
    ctx.font = `400 17px ${MONO}`
    ctx.textBaseline = 'middle'
    ctx.fillText(r.label, 60, y + 10)
    const w = Math.max(3, r.bar * barW)
    ctx.fillStyle = r.color
    roundRect(ctx, barX, y, w, 18, [0, 4, 4, 0])
    ctx.fill()
    ctx.fillStyle = '#b9b1a4'
    ctx.font = `400 17px ${BODY}`
    ctx.textAlign = 'right'
    ctx.fillText(r.value, W - 60, y + 10)
    ctx.textAlign = 'left'
  })
}

function footer(ctx: CanvasRenderingContext2D, site: string, note: string) {
  ctx.fillStyle = '#877f73'
  ctx.font = `400 18px ${BODY}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(site, 60, H - 30)
  ctx.textAlign = 'right'
  ctx.fillText(note, W - 60, H - 30)
  ctx.textAlign = 'left'
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))

/** Renders the snapshot as a 1200x630 image for X and Telegram. Same palette as the app. */
export async function renderShareCard(c: CardInput): Promise<Blob> {
  const [canvas, ctx] = await card()
  header(ctx, 'holder snapshot on Cookie Chain', fmtDate(c.takenAt))
  tokenLine(ctx, c.symbol, c.name, c.mint)

  tiles(ctx, [
    ['Holders', fmtInt(c.holders.length)],
    c.collection ? ['Pieces held', fmtInt(Number(c.held))] : ['Held by them', fmtAmount(c.held, c.decimals, true)],
    ['Top 10 share', fmtPct(c.top10Pct)],
    [c.collection ? 'Held by programs' : 'In pools and vaults', fmtPct(c.poolsPct)],
  ])

  const top = c.holders.slice(0, 5)
  const rest = c.holders.slice(5).reduce((n, h) => n + h.amount, 0n)
  const rows = top.map((h) => ({ label: shortAddr(h.owner, 4, 4), pct: c.held ? Number((h.amount * 100000n) / c.held) / 1000 : 0, other: false }))
  if (rest > 0n) rows.push({ label: `${c.holders.length - 5} others`, pct: c.held ? Number((rest * 100000n) / c.held) / 1000 : 0, other: true })
  const max = Math.max(...rows.map((r) => r.pct), 1)
  bars(ctx, rows.map((r) => ({ label: r.label, bar: r.pct / max, value: fmtPct(r.pct), color: r.other ? 'rgba(255,255,255,0.18)' : '#e0a54a' })))

  footer(ctx, c.site, 'Pools, vaults and escrows excluded')
  return toBlob(canvas)
}

export interface DiffCardInput {
  symbol: string
  name: string
  mint: string
  decimals: number
  collection?: boolean
  from: number
  to: number
  counts: { joined: number; left: number; grew: number; shrank: number }
  holdersBefore: number
  holdersAfter: number
  heldBefore: bigint
  heldAfter: bigint
  /** Biggest moves first. */
  rows: HolderChange[]
  site: string
}

/** Renders the changes between two snapshots as a 1200x630 image. */
export async function renderDiffCard(c: DiffCardInput): Promise<Blob> {
  const [canvas, ctx] = await card()
  header(ctx, 'holder changes on Cookie Chain', `${fmtDate(c.from)} to ${fmtDate(c.to)}`)
  tokenLine(ctx, c.symbol, c.name, c.mint)
  tiles(ctx, [
    ['Joined', fmtInt(c.counts.joined)],
    ['Left', fmtInt(c.counts.left)],
    ['Grew', fmtInt(c.counts.grew)],
    ['Shrank', fmtInt(c.counts.shrank)],
  ])

  const amount = (n: bigint) => (c.collection ? fmtInt(Number(n)) : fmtAmount(n, c.decimals, true))
  ctx.fillStyle = '#b9b1a4'
  ctx.font = `400 20px ${BODY}`
  ctx.textBaseline = 'alphabetic'
  const holdersDelta = c.holdersAfter - c.holdersBefore
  ctx.fillText(
    `Holders ${fmtInt(c.holdersBefore)} to ${fmtInt(c.holdersAfter)} (${holdersDelta < 0 ? '−' : '+'}${fmtInt(Math.abs(holdersDelta))})  ·  ${c.collection ? 'Pieces held' : 'Held'} ${amount(c.heldBefore)} to ${amount(c.heldAfter)}`,
    60,
    382,
  )

  const top = c.rows.slice(0, 5)
  const max = top.reduce((m, r) => (r.delta < 0n ? -r.delta : r.delta) > m ? (r.delta < 0n ? -r.delta : r.delta) : m, 0n)
  bars(
    ctx,
    top.map((r) => ({
      label: shortAddr(r.owner, 4, 4),
      bar: max ? Number(((r.delta < 0n ? -r.delta : r.delta) * 1000n) / max) / 1000 : 0,
      value: `${fmtDelta(r.delta, amount)}${r.change === 'joined' ? ' · joined' : r.change === 'left' ? ' · left' : ''}`,
      color: r.delta < 0n ? '#d97b6c' : '#e0a54a',
    })),
    412,
  )
  if (!top.length) {
    ctx.fillStyle = '#877f73'
    ctx.font = `400 22px ${BODY}`
    ctx.fillText('No wallet moved between the two snapshots.', 60, 440)
  }

  footer(ctx, c.site, 'Pools, vaults and escrows excluded')
  return toBlob(canvas)
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
