import { useEffect, useMemo, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { GameClient } from '../game/client'
import { CRUMB_DECIMALS, CRUMB_MINT, EMISSION_PROGRAM, CLICKER_PROGRAM } from '../game/constants'
import { emissionMath, type DistributorState, type EmissionState } from '../game/codec'
import { addressUrl } from '../lib/chain'
import { fmtAmount, fmtPct, shortAddr } from '../lib/format'
import { toast } from './Toast'
import { IconCopy, IconExternalLink, IconUsers } from '../icons'

/** What CRUMB is, how much exists, and the holder drops. No price anywhere, by design. */
export function Crumb({ onSnapshot }: { onSnapshot: (mint: string) => void }) {
  const { connection } = useConnection()
  const client = useMemo(() => new GameClient(connection), [connection])
  const [e, setE] = useState<EmissionState | null>(null)
  const [d, setD] = useState<DistributorState | null>(null)
  useEffect(() => {
    client.fetchEmission().then(setE).catch(() => {})
    client.fetchDistributor().then(setD).catch(() => {})
  }, [client])
  const m = e ? emissionMath(e) : null
  const mint = CRUMB_MINT.toBase58()
  return (
    <>
      <section className="card">
        <div className="row between">
          <div>
            <h2>CRUMB</h2>
            <p className="lead">Proof of play on Cookie Chain. Minted only by playing, on a fixed schedule that halves as supply is used up. Nobody sells it and this app assigns it no price.</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => navigator.clipboard.writeText(mint).then(() => toast('CRUMB mint address copied'))}><IconCopy /> Mint</button>
            <a className="btn" href={addressUrl(mint)} target="_blank" rel="noreferrer"><IconExternalLink /> Cookiescan</a>
            <button className="btn primary" onClick={() => onSnapshot(mint)}><IconUsers /> Snapshot holders</button>
          </div>
        </div>
        <div className="small muted mono" style={{ marginTop: '.4rem' }}>{mint}</div>
        {e && m && (
          <div className="tiles" style={{ marginTop: '1rem' }}>
            <div className="tile"><div className="label">Minted so far</div><div className="value num">{fmtAmount(e.minted, CRUMB_DECIMALS, true)}</div></div>
            <div className="tile"><div className="label">Max supply</div><div className="value num">{fmtAmount(e.maxSupply, CRUMB_DECIMALS, true)}</div></div>
            <div className="tile"><div className="label">Pool today</div><div className="value num">{fmtAmount(m.poolNow, CRUMB_DECIMALS, true)}</div></div>
            <div className="tile"><div className="label">Halvings so far</div><div className="value num">{m.tranche}</div></div>
          </div>
        )}
        {e && m && (
          <div className="conc" aria-label="Supply progress">
            <div className="conc-bar">
              <span style={{ width: `${Math.max(0.3, Number((e.minted * 10000n) / e.maxSupply) / 100)}%`, background: 'var(--seq-1)' }} />
              <span style={{ width: `${100 - Number((e.minted * 10000n) / e.maxSupply) / 100}%`, background: 'var(--seq-4)' }} />
            </div>
            <div className="conc-legend small">
              <span><i style={{ background: 'var(--seq-1)' }} /> Minted {fmtPct(Number((e.minted * 10000n) / e.maxSupply) / 100, 2)}</span>
              <span><i style={{ background: 'var(--seq-4)' }} /> Next halving at {fmtAmount(m.nextHalvingAt, CRUMB_DECIMALS, true)}</span>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>How it works</h2>
        <div className="rules">
          <div className="rule"><b>Schedule</b><span>{e ? fmtAmount(e.baseDailyPool, CRUMB_DECIMALS, true) : '100K'} CRUMB a day while the first half of the supply is minted. The daily pool halves every time minted supply crosses the halfway mark of what remains. Supply triggers the halvings, not the clock.</span></div>
          <div className="rule"><b>Who mints</b><span>Only registered games and tools, each with a weight of the daily pool. Today: {d ? `${d.name} at ${d.weightBps / 100}%` : 'the clicker at 100%'}. The mint authority is the emission program itself; no key can mint outside the schedule and no key can freeze CRUMB.</span></div>
          <div className="rule"><b>No treasury</b><span>100% of every day's pool goes to players. No team allocation, no seeded pool, no buybacks.</span></div>
          <div className="rule"><b>Sinks</b><span>Starting a game account after the first 500 burns CRUMB, and the burn rises with the player count. Cosmetics will burn too. Sinks exist as game rules, not as supply management.</span></div>
          <div className="rule"><b>Holders</b><span>Value, if any, is the community's to define. Partners can drop to CRUMB holders through the Snapshot and Airdrop tools here, gate allowlists on a holder snapshot, or run signal votes from one.</span></div>
        </div>
        <p className="small muted" style={{ marginTop: '.8rem' }}>
          Programs: emission <a className="mono" href={addressUrl(EMISSION_PROGRAM.toBase58())} target="_blank" rel="noreferrer">{shortAddr(EMISSION_PROGRAM.toBase58(), 6, 6)}</a>, clicker <a className="mono" href={addressUrl(CLICKER_PROGRAM.toBase58())} target="_blank" rel="noreferrer">{shortAddr(CLICKER_PROGRAM.toBase58(), 6, 6)}</a>.
        </p>
      </section>

      <section className="card">
        <h2>Holder drops</h2>
        <p className="lead">Drops, allowlists and votes that used a CRUMB holder snapshot. None yet; the token is a few hours old.</p>
        <p className="small muted">Running a project on Cookie Chain and want to reward the people who play? Take a snapshot of CRUMB holders here, airdrop with the Airdrop tab, and tell us so it is listed.</p>
      </section>
    </>
  )
}
