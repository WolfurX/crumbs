export function shortAddr(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`
}

/** Raw integer amount to a decimal string, no float drift. */
export function rawToUi(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : ''
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '')
}

/** Decimal string to raw integer amount. Throws on too many decimals. */
export function uiToRaw(ui: string, decimals: number): bigint {
  const t = ui.trim()
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') throw new Error(`not a number: "${ui}"`)
  const [int, frac = ''] = t.split('.')
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals`)
  return BigInt((int || '0') + frac.padEnd(decimals, '0'))
}

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
const fullFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

export function fmtAmount(raw: bigint, decimals: number, compact = false): string {
  const n = Number(rawToUi(raw, decimals))
  if (!Number.isFinite(n)) return rawToUi(raw, decimals)
  return compact ? compactFmt.format(n) : fullFmt.format(n)
}

export function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '0%'
  if (x > 0 && x < 0.05) return '<0.1%'
  return `${x.toFixed(digits)}%`
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}
