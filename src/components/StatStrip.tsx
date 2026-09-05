import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { fetchStats, type ChainStats } from '../lib/stats'
import { fmtInt } from '../lib/format'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Live network line under the hero: proof the app is wired to the chain, refreshed every 20 s. */
export function StatStrip() {
  const { connection } = useConnection()
  const [s, setS] = useState<ChainStats | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let stop = false
    const load = () =>
      fetchStats(connection)
        .then((v) => !stop && (setS(v), setErr(false)))
        .catch(() => !stop && setErr(true))
    load()
    const id = setInterval(load, 20_000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [connection])

  if (err && !s) return <div className="stats"><span className="stat"><span className="dot bad" />RPC unreachable</span></div>
  if (!s) return <div className="stats"><span className="stat muted">Reading the chain…</span></div>
  const price = s.cookUsd !== null ? `$${s.cookUsd < 0.01 ? s.cookUsd.toFixed(6) : s.cookUsd.toFixed(4)}` : 'n/a'
  return (
    <div className="stats" aria-label="Cookie Chain live stats">
      <span className="stat"><span className="dot ok live" />Cookie Chain live</span>
      <span className="stat"><b className="num">{fmtInt(s.slot)}</b> slot</span>
      <span className="stat">epoch <b className="num">{s.epoch}</b> <span className="muted num">{s.epochPct.toFixed(0)}%</span></span>
      <span className="stat"><b className="num">{s.tps.toFixed(1)}</b> tps</span>
      <span className="stat"><b className="num">{compact.format(s.txCount)}</b> transactions</span>
      <span className="stat">COOK <b className="num">{price}</b></span>
      <span className="stat"><b className="num">{fmtInt(s.tokens)}</b> tokens indexed</span>
    </div>
  )
}
