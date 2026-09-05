import { useState } from 'react'
import type { Holder } from '../lib/das'
import { fmtAmount, fmtPct, shortAddr } from '../lib/format'

interface Props {
  holders: Holder[]
  total: bigint
  decimals: number
  symbol: string
  top?: number
}

/** Top holders as thin horizontal bars: one hue, share at the tip, the rest folded into "Others". */
export function HolderChart({ holders, total, decimals, symbol, top = 10 }: Props) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  if (!holders.length || total === 0n) return null
  const head = holders.slice(0, top)
  const rest = holders.slice(top).reduce((n, h) => n + h.amount, 0n)
  const pct = (a: bigint) => Number((a * 100000n) / total) / 1000
  const max = Math.max(pct(head[0].amount), pct(rest))

  const rows = head.map((h) => ({ label: shortAddr(h.owner, 4, 4), value: h.amount, pct: pct(h.amount), owner: h.owner, program: h.isProgram }))
  if (rest > 0n) rows.push({ label: `${holders.length - top} others`, value: rest, pct: pct(rest), owner: '', program: false })

  return (
    <div className="bars" onMouseLeave={() => setTip(null)}>
      {rows.map((r) => (
        <div
          key={r.owner || 'others'}
          className={`bar-row${r.owner ? '' : ' other'}`}
          onMouseMove={(e) =>
            setTip({
              x: e.clientX,
              y: e.clientY,
              text: `${r.owner || r.label}${r.program ? ' (program account)' : ''}: ${fmtAmount(r.value, decimals)} ${symbol}`,
            })
          }
        >
          <span className="mono ink2">{r.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.max(0.5, (r.pct / max) * 100)}%` }} />
          </div>
          <span className="num right ink2">{fmtPct(r.pct)}</span>
        </div>
      ))}
      {tip && (
        <div className="tip mono" style={{ left: Math.min(tip.x + 12, window.innerWidth - 330), top: tip.y + 14 }}>
          {tip.text}
        </div>
      )}
    </div>
  )
}
