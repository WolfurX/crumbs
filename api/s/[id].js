// Read-only route: serves a finalized crumb_store blob by account address, with its stored content
// type. No secrets, no state; everything comes from the chain on each request and is cached for a
// year because finalized blobs never change.
// Layout (crumb_store): 0..8 "crumblob" | 8..40 authority | 40..44 len u32 LE | 44 finalized |
// 45 mime len | 46..78 mime | 78..96 reserved | 96.. data
const RPC = 'https://rpc.cookiescan.io'
const STORE_PROGRAM = 'A9bmhLfaJRUQKQvRktrtztg1w3hoRjp5UVc5TUhcaq2J'
const HEADER = 96
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(204).end()
  const id = String(req.query.id || '')
  if (!B58.test(id)) return res.status(400).send('bad address')
  let info
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [id, { encoding: 'base64', commitment: 'confirmed' }] }),
    })
    info = (await r.json()).result?.value
  } catch {
    return res.status(502).send('rpc unavailable')
  }
  if (!info || info.owner !== STORE_PROGRAM) return res.status(404).send('not found')
  const buf = Buffer.from(info.data[0], 'base64')
  if (buf.length < HEADER || buf.subarray(0, 8).toString('latin1') !== 'crumblob') return res.status(404).send('not a blob')
  if (buf[44] !== 1) return res.status(409).send('not finalized')
  const len = buf.readUInt32LE(40)
  const mimeLen = buf[45]
  const mime = buf.subarray(46, 46 + Math.min(mimeLen, 32)).toString('latin1')
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(mime)) return res.status(404).send('bad mime')
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.status(200).send(buf.subarray(HEADER, HEADER + len))
}
