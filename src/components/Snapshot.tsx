import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { fetchHolders, type Holder } from '../lib/das'
import { loadRegistry, searchRegistry, type TokenInfo } from '../lib/tokens'
import { COOK_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressUrl, isPubkey } from '../lib/chain'
import { fmtAmount, fmtInt, fmtPct, shortAddr } from '../lib/format'
import { HolderChart } from './HolderChart'
import { ArtSnapshot } from './Art'
import { IconAperture, IconDownload, IconParachute } from '../icons'

export interface SnapshotResult {
  token: TokenInfo
  holders: Holder[]
  total: bigint
  takenAt: number
}

interface Props {
  result: SnapshotResult | null
  onResult: (r: SnapshotResult) => void
  onAirdrop: () => void
}

export function Snapshot({ result, onResult, onAirdrop }: Props) {
  const { connection } = useConnection()
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<Map<string, TokenInfo> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hideProgram, setHideProgram] = useState(true)
  const [minUi, setMinUi] = useState('')
  const [showAll, setShowAll] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => setRegistry(new Map()))
  }, [])

  const suggestions = useMemo(() => (registry && !isPubkey(query) ? searchRegistry(registry, query) : []), [registry, query])

  async function take(mint: string) {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setError(null)
    setBusy('Reading token…')
    try {
      if (mint === COOK_MINT) throw new Error('Native COOK has no token accounts to snapshot. Pick a token.')
      const pk = new PublicKey(mint)
      let token = registry?.get(mint)
      if (!token) {
        const info = await connection.getAccountInfo(pk)
        if (!info) throw new Error('No account at that address on Cookie Chain.')
        if (!info.owner.equals(TOKEN_PROGRAM) && !info.owner.equals(TOKEN_2022_PROGRAM)) throw new Error('That address is not a token mint.')
        const m = await getMint(connection, pk, 'confirmed', info.owner)
        token = { mint, symbol: shortAddr(mint, 4, 3), name: 'Unlisted token', decimals: m.decimals }
      }
      setBusy('Fetching holders…')
      const holders = await fetchHolders(mint, (n) => setBusy(`Fetching holders… ${fmtInt(n)} accounts`), ac.signal)
      if (ac.signal.aborted) return
      const total = holders.reduce((n, h) => n + h.amount, 0n)
      onResult({ token, holders, total, takenAt: Date.now() })
      setQuery('')
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message)
    } finally {
      if (!ac.signal.aborted) setBusy(null)
    }
  }

  const view = useMemo(() => {
    if (!result) return null
    const min = minUi.trim() ? BigInt(Math.floor(Number(minUi) * 10 ** result.token.decimals)) : 0n
    const rows = result.holders.filter((h) => (!hideProgram || !h.isProgram) && h.amount >= min)
    const held = rows.reduce((n, h) => n + h.amount, 0n)
    const top10 = rows.slice(0, 10).reduce((n, h) => n + h.amount, 0n)
    const programHeld = result.holders.filter((h) => h.isProgram).reduce((n, h) => n + h.amount, 0n)
    return { rows, held, top10, programHeld }
  }, [result, hideProgram, minUi])

  function exportCsv() {
    if (!result || !view) return
    const d = result.token.decimals
    const lines = ['rank,owner,balance,share_pct,accounts,program_account', ...view.rows.map((h, i) => `${i + 1},${h.owner},${fmtAmount(h.amount, d).replace(/,/g, '')},${(Number((h.amount * 100000n) / (view.held || 1n)) / 1000).toFixed(3)},${h.accounts},${h.isProgram}`)]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${result.token.symbol || 'token'}-holders-${new Date(result.takenAt).toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <>
      <section className={`card${result ? '' : ' empty'}`}>
        <div>
        <h2>Holder snapshot</h2>
        <p className="lead">Every wallet holding a token, straight from the Cookiescan index. Filter it, export it, airdrop to it.</p>
        <div className="field" style={{ position: 'relative' }}>
          <span>Token mint or symbol</span>
          <input
            className="input mono"
            placeholder="e.g. bCOOK or EkPafx58…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (isPubkey(query)) take(query.trim())
                else if (suggestions[0]) take(suggestions[0].mint)
              }
            }}
            spellCheck={false}
          />
          {suggestions.length > 0 && (
            <div className="menu" style={{ left: 0, right: 'auto', top: '100%', minWidth: 320 }}>
              {suggestions.map((t) => (
                <button key={t.mint} onClick={() => take(t.mint)}>
                  {t.logo ? <img src={t.logo} alt="" /> : <span style={{ width: 20 }} />}
                  <span>
                    {t.symbol} <span className="muted">{t.name}</span>
                  </span>
                  {t.holderCount !== undefined && <span className="muted num" style={{ marginLeft: 'auto' }}>{fmtInt(t.holderCount)} holders</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button className="btn primary" disabled={!!busy || !isPubkey(query)} onClick={() => take(query.trim())}>
            <IconAperture /> Take snapshot
          </button>
          {busy && <span className="muted">{busy}</span>}
          {error && <span className="err">{error}</span>}
        </div>
        </div>
        {!result && <ArtSnapshot />}
      </section>

      {result && view && (
        <section className="card">
          <div className="row between">
            <div className="row">
              {result.token.logo && <img src={result.token.logo} alt="" width={28} height={28} style={{ borderRadius: 6 }} />}
              <div>
                <h2>{result.token.symbol}</h2>
                <div className="small muted">
                  <a className="mono" href={addressUrl(result.token.mint)} target="_blank" rel="noreferrer">{shortAddr(result.token.mint, 6, 6)}</a>
                  {' · '}
                  {new Date(result.takenAt).toLocaleString()}
                </div>
              </div>
            </div>
            <div className="row">
              <button className="btn" onClick={exportCsv}><IconDownload /> Export CSV</button>
              <button className="btn primary" onClick={onAirdrop}><IconParachute /> Airdrop to {fmtInt(view.rows.length)} holders</button>
            </div>
          </div>

          <div className="tiles" style={{ marginTop: '1rem' }}>
            <div className="tile"><div className="label">Holders</div><div className="value num">{fmtInt(view.rows.length)}</div></div>
            <div className="tile"><div className="label">Held by them</div><div className="value num">{fmtAmount(view.held, result.token.decimals, true)}</div></div>
            <div className="tile"><div className="label">Top 10 share</div><div className="value num">{fmtPct(view.held ? Number((view.top10 * 1000n) / view.held) / 10 : 0)}</div></div>
            <div className="tile"><div className="label">In pools and vaults</div><div className="value num">{fmtPct(result.total ? Number((view.programHeld * 1000n) / result.total) / 10 : 0)}</div></div>
          </div>

          <div className="row" style={{ margin: '0.9rem 0' }}>
            <label className="check"><input type="checkbox" checked={hideProgram} onChange={(e) => setHideProgram(e.target.checked)} /> Hide program accounts (pools, vaults, escrows)</label>
            <label className="field" style={{ gridTemplateColumns: 'auto 120px', display: 'grid', alignItems: 'center', gap: '0.5rem' }}>
              <span>Min balance</span>
              <input className="input num" inputMode="decimal" value={minUi} onChange={(e) => setMinUi(e.target.value)} placeholder="0" />
            </label>
          </div>

          <HolderChart holders={view.rows} total={view.held} decimals={result.token.decimals} symbol={result.token.symbol} />

          <hr className="hr" />
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>#</th><th>Owner</th><th className="right">Balance</th><th className="right">Share</th><th></th></tr>
              </thead>
              <tbody>
                {(showAll ? view.rows : view.rows.slice(0, 25)).map((h, i) => (
                  <tr key={h.owner}>
                    <td className="muted num">{i + 1}</td>
                    <td><a className="mono" href={addressUrl(h.owner)} target="_blank" rel="noreferrer">{shortAddr(h.owner, 6, 6)}</a></td>
                    <td className="right num">{fmtAmount(h.amount, result.token.decimals)}</td>
                    <td className="right num muted">{fmtPct(view.held ? Number((h.amount * 100000n) / view.held) / 1000 : 0)}</td>
                    <td>{h.isProgram && <span className="pill">program</span>}{h.frozen && <span className="pill">frozen</span>}{h.accounts > 1 && <span className="pill">{h.accounts} accounts</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.rows.length > 25 && (
            <button className="btn quiet" style={{ marginTop: '0.5rem' }} onClick={() => setShowAll((s) => !s)}>
              {showAll ? 'Show top 25' : `Show all ${fmtInt(view.rows.length)}`}
            </button>
          )}
        </section>
      )}
    </>
  )
}
