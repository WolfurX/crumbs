import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { fetchHolders, type Holder } from '../lib/das'
import { loadRegistry, searchRegistry, type TokenInfo } from '../lib/tokens'
import { COOK_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, addressUrl, isPubkey } from '../lib/chain'
import { fmtAmount, fmtInt, fmtPct, shortAddr } from '../lib/format'
import { loadRecent, pushRecent, timeAgo, type RecentSnapshot } from '../lib/recent'
import { renderShareCard } from '../lib/sharecard'
import { HolderChart } from './HolderChart'
import { ArtSnapshot } from './Art'
import { toast } from './Toast'
import { IconAperture, IconCheck, IconChevronDown, IconCoins, IconCopy, IconDownload, IconExternalLink, IconParachute, IconSearch, IconShieldCheck } from '../icons'
import { CRUMB_MINT } from '../game/constants'

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
  presetMint?: string | null
  onPresetUsed?: () => void
}

type SortKey = 'balance' | 'owner' | 'accounts'
const PAGE = 25
const usd = (n: number) => (n >= 1 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toPrecision(3)}`)

export function Snapshot({ result, onResult, onAirdrop, presetMint, onPresetUsed }: Props) {
  const { connection } = useConnection()
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<Map<string, TokenInfo> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hideProgram, setHideProgram] = useState(true)
  const [minUi, setMinUi] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'balance', dir: -1 })
  const [shown, setShown] = useState(PAGE)
  const [recent, setRecent] = useState<RecentSnapshot[]>(() => loadRecent())
  const [sharing, setSharing] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => setRegistry(new Map()))
  }, [])

  // another tab asked for a snapshot of a specific mint
  useEffect(() => {
    if (presetMint && registry) {
      onPresetUsed?.()
      void take(presetMint)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetMint, registry])

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
        token = mint === CRUMB_MINT.toBase58() ? { mint, symbol: 'CRUMB', name: 'Crumb, proof of play', decimals: m.decimals } : { mint, symbol: shortAddr(mint, 4, 3), name: 'Unlisted token', decimals: m.decimals }
      }
      setBusy('Fetching holders…')
      const holders = await fetchHolders(mint, (n) => setBusy(`Fetching holders… ${fmtInt(n)} accounts`), ac.signal)
      if (ac.signal.aborted) return
      const total = holders.reduce((n, h) => n + h.amount, 0n)
      const takenAt = Date.now()
      onResult({ token, holders, total, takenAt })
      setRecent(pushRecent({ mint, symbol: token.symbol, holders: holders.filter((h) => !h.isProgram).length, takenAt }))
      setQuery('')
      setSearch('')
      setShown(PAGE)
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
    const pct = (a: bigint) => (held ? Number((a * 100000n) / held) / 1000 : 0)
    const top1 = rows.slice(0, 1).reduce((n, h) => n + h.amount, 0n)
    const top10 = rows.slice(0, 10).reduce((n, h) => n + h.amount, 0n)
    const top50 = rows.slice(0, 50).reduce((n, h) => n + h.amount, 0n)
    const programHeld = result.holders.filter((h) => h.isProgram).reduce((n, h) => n + h.amount, 0n)
    const q = search.trim().toLowerCase()
    let table = q ? rows.filter((h) => h.owner.toLowerCase().includes(q)) : rows
    table = [...table].sort((a, b) => {
      if (sort.key === 'owner') return a.owner.localeCompare(b.owner) * sort.dir
      if (sort.key === 'accounts') return (a.accounts - b.accounts) * sort.dir
      return (a.amount > b.amount ? 1 : a.amount < b.amount ? -1 : 0) * sort.dir
    })
    const rank = new Map(rows.map((h, i) => [h.owner, i + 1]))
    return {
      rows,
      held,
      pct,
      top1Pct: pct(top1),
      top10Pct: pct(top10),
      top50Pct: pct(top50),
      restPct: Math.max(0, 100 - pct(top50)),
      poolsPct: result.total ? Number((programHeld * 1000n) / result.total) / 10 : 0,
      table,
      rank,
    }
  }, [result, hideProgram, minUi, search, sort])

  function exportCsv() {
    if (!result || !view) return
    const d = result.token.decimals
    const lines = ['rank,owner,balance,share_pct,accounts,program_account', ...view.rows.map((h, i) => `${i + 1},${h.owner},${fmtAmount(h.amount, d).replace(/,/g, '')},${view.pct(h.amount).toFixed(3)},${h.accounts},${h.isProgram}`)]
    download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${result.token.symbol || 'token'}-holders-${new Date(result.takenAt).toISOString().slice(0, 10)}.csv`)
    toast(`CSV with ${fmtInt(view.rows.length)} holders saved`)
  }

  async function share() {
    if (!result || !view) return
    setSharing(true)
    try {
      const blob = await renderShareCard({
        symbol: result.token.symbol,
        name: result.token.name,
        mint: result.token.mint,
        holders: view.rows,
        held: view.held,
        decimals: result.token.decimals,
        top10Pct: view.top10Pct,
        poolsPct: view.poolsPct,
        takenAt: result.takenAt,
        site: location.host + (import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')),
      })
      const file = new File([blob], `${result.token.symbol || 'token'}-holders.png`, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${result.token.symbol} holders on Cookie Chain` })
      } else {
        download(blob, file.name)
        toast('Share card saved as PNG')
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('Could not render the card: ' + (e as Error).message)
    } finally {
      setSharing(false)
    }
  }

  function copyMint() {
    if (!result) return
    navigator.clipboard.writeText(result.token.mint).then(() => toast('Mint address copied'))
  }

  const th = (key: SortKey, label: string, right = false) => (
    <th className={right ? 'right' : ''}>
      <button className="th" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : -1 }))} aria-sort={sort.key === key ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none'}>
        {label} {sort.key === key && <IconChevronDown style={{ transform: sort.dir === 1 ? 'rotate(180deg)' : undefined }} />}
      </button>
    </th>
  )

  return (
    <>
      <section className={`card${result ? '' : ' empty'}`}>
        <div>
          <h2>Holder snapshot</h2>
          <p className="lead">Every wallet holding a token, straight from the Cookiescan index. Filter it, export it, share it, airdrop to it.</p>
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
            <button className="btn" disabled={!!busy} onClick={() => take(CRUMB_MINT.toBase58())} title="Every wallet holding CRUMB right now">
              <IconCoins /> CRUMB holders
            </button>
            {busy && <span className="muted">{busy}</span>}
            {error && <span className="err">{error}</span>}
          </div>
          {!result && recent.length > 0 && (
            <div className="recent">
              <span className="muted small">Recent</span>
              {recent.map((r) => (
                <button key={r.mint} className="chip" onClick={() => take(r.mint)} disabled={!!busy}>
                  {r.symbol} <span className="muted">{fmtInt(r.holders)} holders · {timeAgo(r.takenAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {!result && <ArtSnapshot />}
      </section>

      {result && view && (
        <section className="card">
          <div className="tokenhead">
            <div className="row">
              <span className="logo mono" aria-hidden="true">
                {(result.token.symbol || '?').slice(0, 2).toUpperCase()}
                {result.token.logo && <img src={result.token.logo} alt="" width={40} height={40} className="logo over" onError={(e) => (e.currentTarget.style.display = 'none')} />}
              </span>
              <div>
                <h2 className="row" style={{ gap: '0.4rem' }}>
                  {result.token.symbol}
                  {result.token.verified && <span title="Listed as verified on Cookiescan" style={{ color: 'var(--accent)', fontSize: '1rem', display: 'inline-flex' }}><IconShieldCheck /></span>}
                  <span className="muted" style={{ fontWeight: 400 }}>{result.token.name}</span>
                </h2>
                <div className="small muted row" style={{ gap: '0.5rem' }}>
                  <span className="mono">{shortAddr(result.token.mint, 6, 6)}</span>
                  <button className="btn quiet sm" onClick={copyMint} title="Copy mint"><IconCopy /></button>
                  <a className="btn quiet sm" href={addressUrl(result.token.mint)} target="_blank" rel="noreferrer" title="Open on Cookiescan"><IconExternalLink /></a>
                  {result.token.priceUsd !== undefined && <span className="num">{usd(result.token.priceUsd)}</span>}
                  {result.token.marketCap !== undefined && <span className="num">MC {usd(result.token.marketCap)}</span>}
                  <span>{new Date(result.takenAt).toLocaleString()}</span>
                </div>
              </div>
            </div>
            <div className="row">
              <button className="btn" onClick={exportCsv}><IconDownload /> CSV</button>
              <button className="btn" onClick={share} disabled={sharing}><IconExternalLink /> {sharing ? 'Rendering…' : 'Share card'}</button>
              <button className="btn primary" onClick={onAirdrop}><IconParachute /> Airdrop to {fmtInt(view.rows.length)}</button>
            </div>
          </div>

          <div className="tiles" style={{ marginTop: '1rem' }}>
            <div className="tile"><div className="label">Holders</div><div className="value num">{fmtInt(view.rows.length)}</div></div>
            <div className="tile"><div className="label">Held by them</div><div className="value num">{fmtAmount(view.held, result.token.decimals, true)}</div></div>
            <div className="tile"><div className="label">Top 10 share</div><div className="value num">{fmtPct(view.top10Pct)}</div></div>
            <div className="tile"><div className="label">In pools and vaults</div><div className="value num">{fmtPct(view.poolsPct)}</div></div>
          </div>

          <div className="conc" aria-label="Concentration">
            <div className="conc-bar">
              <span style={{ width: `${view.top1Pct}%`, background: 'var(--seq-1)' }} title={`Largest holder ${fmtPct(view.top1Pct)}`} />
              <span style={{ width: `${Math.max(0, view.top10Pct - view.top1Pct)}%`, background: 'var(--seq-2)' }} title={`Holders 2 to 10 ${fmtPct(view.top10Pct - view.top1Pct)}`} />
              <span style={{ width: `${Math.max(0, view.top50Pct - view.top10Pct)}%`, background: 'var(--seq-3)' }} title={`Holders 11 to 50 ${fmtPct(view.top50Pct - view.top10Pct)}`} />
              <span style={{ width: `${view.restPct}%`, background: 'var(--seq-4)' }} title={`Everyone else ${fmtPct(view.restPct)}`} />
            </div>
            <div className="conc-legend small">
              {(
                [
                  ['var(--seq-1)', 'Largest holder', view.top1Pct],
                  ['var(--seq-2)', 'Top 2 to 10', view.top10Pct - view.top1Pct],
                  ['var(--seq-3)', 'Top 11 to 50', view.top50Pct - view.top10Pct],
                  ['var(--seq-4)', 'Everyone else', view.restPct],
                ] as [string, string, number][]
              )
                .filter(([, , p]) => p > 0.05)
                .map(([c, label, p]) => (
                  <span key={label}><i style={{ background: c }} /> {label} {fmtPct(p)}</span>
                ))}
            </div>
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
          <div className="row between" style={{ marginBottom: '0.6rem' }}>
            <label className="search">
              <IconSearch />
              <input className="input mono" placeholder="Find an address" value={search} onChange={(e) => (setSearch(e.target.value), setShown(PAGE))} spellCheck={false} />
            </label>
            <span className="muted small num">{fmtInt(view.table.length)} of {fmtInt(view.rows.length)}</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>#</th>{th('owner', 'Owner')}{th('balance', 'Balance', true)}<th className="right">Share</th>{th('accounts', '', true)}</tr>
              </thead>
              <tbody>
                {view.table.slice(0, shown).map((h) => (
                  <tr key={h.owner}>
                    <td className="muted num">{view.rank.get(h.owner)}</td>
                    <td><a className="mono" href={addressUrl(h.owner)} target="_blank" rel="noreferrer">{shortAddr(h.owner, 6, 6)}</a></td>
                    <td className="right num">{fmtAmount(h.amount, result.token.decimals)}</td>
                    <td className="right num muted">{fmtPct(view.pct(h.amount))}</td>
                    <td className="right">{h.isProgram && <span className="pill">program</span>}{h.frozen && <span className="pill">frozen</span>}{h.accounts > 1 && <span className="pill">{h.accounts} accounts</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.table.length > shown && (
            <button className="btn quiet" style={{ marginTop: '0.5rem' }} onClick={() => setShown((n) => n + 100)}>
              <IconChevronDown /> Show {fmtInt(Math.min(100, view.table.length - shown))} more
            </button>
          )}
          {shown > PAGE && view.table.length > PAGE && (
            <button className="btn quiet" style={{ marginTop: '0.5rem' }} onClick={() => setShown(PAGE)}><IconCheck /> Back to top 25</button>
          )}
        </section>
      )}
    </>
  )
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
