import { fmtInt, shortAddr } from '../lib/format'

export interface DropCardInput {
  name: string
  symbol: string
  pieces: number
  royaltyBps: number
  collection: string
  /** The drop's picture as a data or object URL. */
  image: string
  createdAt: number
  site: string
}

const W = 1200
const H = 630

/** A finished drop as a 1200x630 image for X and Telegram: the picture, the name, the numbers. Same palette as the snapshot card. */
export async function renderDropCard(c: DropCardInput): Promise<Blob> {
  await document.fonts.ready.catch(() => {})
  const img = new Image()
  img.src = c.image
  await img.decode()
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
  ctx.fillText('NFT drop on Cookie Chain', 208, 71)
  ctx.textAlign = 'right'
  ctx.fillText(new Date(c.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), W - 60, 71)
  ctx.textAlign = 'left'

  // the picture, square, cropped to fit
  const px = 60
  const py = 130
  const ps = 400
  ctx.save()
  roundRect(ctx, px, py, ps, ps, 10)
  ctx.clip()
  const scale = Math.max(ps / img.width, ps / img.height)
  const dw = img.width * scale
  const dh = img.height * scale
  ctx.drawImage(img, px + (ps - dw) / 2, py + (ps - dh) / 2, dw, dh)
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  roundRect(ctx, px + 0.5, py + 0.5, ps - 1, ps - 1, 10)
  ctx.stroke()

  // name, shrunk to fit the column
  const x = px + ps + 50
  const width = W - 60 - x
  ctx.fillStyle = '#ece6da'
  ctx.textBaseline = 'alphabetic'
  let size = 60
  for (; size > 30; size -= 2) {
    ctx.font = `700 ${size}px ${display}`
    if (ctx.measureText(c.name).width <= width) break
  }
  ctx.fillText(c.name, x, 200)
  ctx.fillStyle = '#877f73'
  ctx.font = `400 26px ${body}`
  ctx.fillText(`${c.symbol} · ${fmtInt(c.pieces)} numbered piece${c.pieces === 1 ? '' : 's'}`, x, 244)

  // tiles
  const tiles: [string, string][] = [
    ['Pieces', fmtInt(c.pieces)],
    ['Royalty', `${(c.royaltyBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`],
    ['Picture', 'on chain'],
  ]
  const ty0 = 290
  const tw = width / tiles.length
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'
  ctx.strokeRect(x + 0.5, ty0 + 0.5, width - 1, 96)
  tiles.forEach(([label, value], i) => {
    const tx = x + i * tw
    if (i) {
      ctx.beginPath()
      ctx.moveTo(tx + 0.5, ty0)
      ctx.lineTo(tx + 0.5, ty0 + 96)
      ctx.stroke()
    }
    ctx.fillStyle = '#877f73'
    ctx.font = `400 18px ${body}`
    ctx.fillText(label, tx + 20, ty0 + 34)
    ctx.fillStyle = '#ece6da'
    ctx.font = `600 34px ${display}`
    ctx.fillText(value, tx + 20, ty0 + 76)
  })

  ctx.fillStyle = '#b9b1a4'
  ctx.font = `400 22px ${body}`
  ctx.fillText('Standard Metaplex NFTs: master edition, verified collection,', x, 440)
  ctx.fillText('picture and metadata stored on Cookie Chain itself.', x, 472)
  ctx.fillStyle = '#877f73'
  ctx.font = `400 20px ${mono}`
  ctx.fillText(`collection ${shortAddr(c.collection, 8, 8)}`, x, 520)

  // footer
  ctx.font = `400 18px ${body}`
  ctx.fillText(c.site, 60, H - 30)
  ctx.textAlign = 'right'
  ctx.fillText('Minted with Crumbs, no fee', W - 60, H - 30)
  ctx.textAlign = 'left'

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
