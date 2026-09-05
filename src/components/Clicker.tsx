import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, Transaction } from "@solana/web3.js"
import { GameClient, explainGameError } from '../game/client'
import { createSession, exportSession, forgetSession, importSession, loadSession } from '../game/session'
import { CRUMB_DECIMALS, MILLI, TIER_CPS_MILLI, TIER_LINES, TIER_NAMES, TIERS, dayIndex, tierPriceMilli } from '../game/constants'
import { emissionMath, type DayState, type DistributorState, type EmissionState, type GameState, type PlayerState } from '../game/codec'
import { COOK_DECIMALS, addressUrl, txUrl } from '../lib/chain'
import { fmtAmount, fmtInt, shortAddr } from '../lib/format'
import { toast } from './Toast'
import { IconCookie, IconCopy, IconDownload, IconRefresh, IconUsers } from '../icons'

const TOPUP_LAMPORTS = 100_000_000 // 0.1 COOK, about 20,000 clicks
const CLICK_GAP_MS = 480 // the program takes two clicks per second

interface Feed { id: number; state: 'sent' | 'ok' | 'fail'; note?: string; sig?: string }

const cookies = (milli: bigint) => Number(milli) / 1000
const fmtCookies = (milli: bigint) => {
  const n = cookies(milli)
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 1 : 0 })
}
const fmtCps = (milli: bigint) => (Number(milli) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })
const fmtCrumb = (raw: bigint) => fmtAmount(raw, CRUMB_DECIMALS)

export function Clicker({ onSnapshot }: { onSnapshot: (mint: string) => void }) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const client = useMemo(() => new GameClient(connection), [connection])
  const owner = wallet.publicKey

  const [game, setGame] = useState<GameState | null>(null)
  const [emission, setEmission] = useState<EmissionState | null>(null)
  const [distributor, setDistributor] = useState<DistributorState | null>(null)
  const [player, setPlayer] = useState<PlayerState | null | undefined>(undefined)
  const [session, setSession] = useState<Keypair | null>(null)
  const [sessionBalance, setSessionBalance] = useState<bigint>(0n)
  const [crumbBalance, setCrumbBalance] = useState<bigint>(0n)
  const [board, setBoard] = useState<PlayerState[]>([])
  const [yesterday, setYesterday] = useState<DayState | null>(null)
  const [feed, setFeed] = useState<Feed[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [optimistic, setOptimistic] = useState<bigint>(0n)
  const lastClick = useRef(0)
  const feedId = useRef(1)
  const syncAt = useRef(Date.now())

  const load = useCallback(async () => {
    try {
      const [g, e, d] = await Promise.all([client.fetchGame(), client.fetchEmission(), client.fetchDistributor()])
      setGame(g); setEmission(e); setDistributor(d)
      if (owner) {
        const p = await client.fetchPlayer(owner)
        setPlayer(p)
        syncAt.current = Date.now()
        setOptimistic(0n)
        const s = loadSession(owner)
        setSession(s)
        if (s) setSessionBalance(BigInt(await connection.getBalance(s.publicKey)))
        setCrumbBalance(await client.fetchCrumbBalance(owner))
        if (p && p.pendingDay !== dayIndex(Date.now() / 1000) && (p.pendingCookiesMilli > 0n || p.pendingClicks > 0n)) setYesterday(await client.fetchDay(p.pendingDay))
        else setYesterday(null)
      } else setPlayer(undefined)
      setBoard(await client.leaderboard(20))
    } catch (e) {
      setError(explainGameError(e))
    }
  }, [client, connection, owner])

  useEffect(() => {
    void load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [load])

  // 10 fps counter for the live cookie total
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [])

  const liveCookies = useMemo(() => {
    if (!player) return 0n
    const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - syncAt.current) / 1000)))
    return player.cookiesMilli + player.cpsMilli * elapsed + optimistic
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, optimistic, tick])

  const todayIdx = dayIndex(Date.now() / 1000)
  const clicksToday = player ? (player.clickDay === todayIdx ? player.clicksToday : 0) : 0
  const clickPower = player ? MILLI + player.cpsMilli / 1000n : MILLI
  const math = emission ? emissionMath(emission) : null

  async function signWithWallet(ixs: Parameters<Transaction['add']>) {
    if (!owner || !wallet.signTransaction) throw new Error('Wallet cannot sign')
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(...ixs)
    const signed = await wallet.signTransaction(tx)
    const signature = await connection.sendRawTransaction(signed.serialize())
    const r = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (r.value.err) throw new Error(`On-chain error ${JSON.stringify(r.value.err)}`)
    return signature
  }

  async function start() {
    if (!owner || !game) return
    setBusy('Waiting for your wallet…')
    setError(null)
    try {
      const s = loadSession(owner) ?? createSession(owner)
      setSession(s)
      const burn = entryBurn(game)
      await signWithWallet([client.startIx(owner, s.publicKey, game, burn), client.topUpIx(owner, s.publicKey, TOPUP_LAMPORTS)])
      toast('You are in. The session key is funded with 0.1 COOK.')
      await load()
      setTimeout(() => void load(), 2500)
    } catch (e) {
      setError(explainGameError(e))
    } finally {
      setBusy(null)
    }
  }

  async function topUp() {
    if (!owner || !session) return
    setBusy('Waiting for your wallet…')
    try {
      await signWithWallet([client.topUpIx(owner, session.publicKey, TOPUP_LAMPORTS)])
      toast('Session key topped up with 0.1 COOK')
      await load()
    } catch (e) {
      setError(explainGameError(e))
    } finally {
      setBusy(null)
    }
  }

  async function withdraw() {
    if (!owner || !session) return
    const bal = await connection.getBalance(session.publicKey)
    const keep = 5_000 * 2
    if (bal <= keep) return toast('Nothing to withdraw')
    setBusy('Withdrawing…')
    try {
      const sig = await client.sendWithSession(session, [client.withdrawIx(session.publicKey, owner, bal - keep)])
      await client.confirm(sig)
      toast(`Sent ${fmtAmount(BigInt(bal - keep), COOK_DECIMALS)} COOK back to your wallet`)
      await load()
    } catch (e) {
      setError(explainGameError(e))
    } finally {
      setBusy(null)
    }
  }

  function pushFeed(f: Feed) {
    setFeed((old) => [f, ...old].slice(0, 24))
  }
  function updateFeed(id: number, patch: Partial<Feed>) {
    setFeed((old) => old.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }

  async function click() {
    if (!owner || !session || !player || !game) return
    const now = Date.now()
    if (now - lastClick.current < CLICK_GAP_MS) return
    lastClick.current = now
    if (clicksToday + feed.filter((f) => f.state === 'sent').length >= game.clickCapPerDay) {
      setError(CLICK_CAP_MSG)
      return
    }
    const id = feedId.current++
    setOptimistic((o) => o + clickPower)
    pushFeed({ id, state: 'sent' })
    try {
      const sig = await client.sendWithSession(session, [client.clickIx(session.publicKey, owner, player, now / 1000)])
      updateFeed(id, { sig: sig.signature })
      await client.confirm(sig)
      updateFeed(id, { state: 'ok' })
      setPlayer((p) => (p ? { ...p, clicksToday: (p.clickDay === todayIdx ? p.clicksToday : 0) + 1, clickDay: todayIdx, lifetimeClicks: p.lifetimeClicks + 1n } : p))
    } catch (e) {
      const note = explainGameError(e)
      updateFeed(id, { state: 'fail', note })
      setOptimistic((o) => (o >= clickPower ? o - clickPower : 0n))
      if (/day rolled|settling/i.test(note)) void load()
    }
  }

  async function sessionAction(label: string, build: () => ReturnType<GameClient['clickIx']>[]) {
    if (!session) return
    setBusy(label)
    setError(null)
    try {
      const sig = await client.sendWithSession(session, build())
      await client.confirm(sig)
      await load()
      return sig.signature
    } catch (e) {
      setError(explainGameError(e))
    } finally {
      setBusy(null)
    }
  }

  const buy = (tier: number) => owner && player && sessionAction(`Buying ${TIER_NAMES[tier]}…`, () => [client.buyIx(session!.publicKey, owner, player, tier, 1)]).then((s) => s && toast(`${TIER_NAMES[tier]} bought`))
  const settle = () => owner && player && sessionAction('Settling yesterday…', () => [client.settleIx(session!.publicKey, owner, player)]).then((s) => s && toast('Yesterday settled into claimable CRUMB'))
  const claim = () => owner && player && sessionAction('Claiming CRUMB…', () => [client.claimIx(session!.publicKey, owner, player)]).then((s) => s && toast(`CRUMB claimed to ${shortAddr(owner.toBase58())}`))

  if (!owner) {
    return (
      <section className="card empty">
        <div>
          <h2>Crumb Clicker</h2>
          <p className="lead">An idle clicker where every click is a transaction on Cookie Chain. Click for cookies, buy bakers that bake while you sleep, turn cookies into CRUMB on a fixed daily schedule.</p>
          <p className="muted small">Connect a wallet to start.</p>
        </div>
        <CookieArt />
      </section>
    )
  }

  if (player === undefined || !game || !emission || !math) return <section className="card"><p className="muted">Reading the game…</p></section>

  if (player === null) {
    const burn = entryBurn(game)
    return (
      <section className="card empty">
        <div>
          <h2>Crumb Clicker</h2>
          <p className="lead">Every click is a transaction. Your browser gets a session key that signs clicks silently; your wallet signs once now to create your player and fund that key with 0.1 COOK, enough for about 20,000 clicks.</p>
          <p className="small muted">
            Start fee {fmtAmount(game.startFeeLamports, COOK_DECIMALS)} COOK plus about 0.002 COOK of account rent.
            {burn > 0n ? ` Free slots are gone: starting also burns ${fmtCrumb(burn)} CRUMB from your wallet.` : ` ${fmtInt(Number(game.freeSlots - game.players))} free slots left before starting costs CRUMB.`}
          </p>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn primary" disabled={!!busy || !wallet.signTransaction} onClick={start}><IconCookie /> {busy ?? 'Start playing'}</button>
            {error && <span className="err">{error}</span>}
          </div>
        </div>
        <CookieArt />
      </section>
    )
  }

  const rank = board.findIndex((p) => p.owner.equals(owner)) + 1
  const sessionLow = sessionBalance < 2_000_000n

  return (
    <>
      <section className="card game">
        <div className="game-grid">
          <div className="game-main">
            <div className="counter">
              <div className="num big">{fmtCookies(liveCookies)}</div>
              <div className="muted small">cookies · {fmtCps(player.cpsMilli)} per second · +{fmtCookies(clickPower)} per click</div>
            </div>
            <button className="cookie-btn" onClick={click} disabled={!session || sessionLow} aria-label="Click the cookie">
              <CookieArt big />
            </button>
            <div className="row between small muted">
              <span className="num">{fmtInt(clicksToday)} / {fmtInt(game.clickCapPerDay)} clicks today</span>
              <span className="feed" aria-label="Recent clicks">
                {feed.slice(0, 16).map((f) => <i key={f.id} className={`fdot ${f.state}`} title={f.note ?? f.state} />)}
              </span>
            </div>
            {error && <p className="err small">{error}</p>}
            {feed.find((f) => f.state === 'fail')?.note && <p className="muted small">Last miss: {feed.find((f) => f.state === 'fail')!.note}</p>}
          </div>

          <aside className="game-side">
            <h3>Session key</h3>
            {session ? (
              <>
                <div className="small mono">{shortAddr(session.publicKey.toBase58(), 6, 6)}</div>
                <div className="num">{fmtAmount(sessionBalance, COOK_DECIMALS)} COOK <span className="muted small">≈ {fmtInt(Number(sessionBalance / 5_000n))} clicks</span></div>
                {sessionLow && <p className="err small">Out of COOK. Top up to keep clicking.</p>}
                <div className="row" style={{ marginTop: '.5rem' }}>
                  <button className="btn sm" disabled={!!busy} onClick={topUp}>Top up 0.1</button>
                  <button className="btn sm" disabled={!!busy} onClick={withdraw}>Withdraw</button>
                  <button className="btn quiet sm" title="Copy the session secret" onClick={() => navigator.clipboard.writeText(exportSession(session)).then(() => toast('Session secret copied. Keep it private.'))}><IconCopy /></button>
                </div>
              </>
            ) : (
              <div className="stack">
                <p className="small muted">This browser has no session key for your player. Restore one or make a new one and register it.</p>
                <button className="btn sm" disabled={!!busy} onClick={async () => { const s = prompt('Paste the session secret'); if (!s) return; try { setSession(importSession(owner, s)); await load() } catch { setError('That is not a valid session secret') } }}>Restore</button>
                <button className="btn sm" disabled={!!busy} onClick={async () => { const s = createSession(owner); setBusy('Waiting for your wallet…'); try { await signWithWallet([client.setSessionIx(owner, s.publicKey), client.topUpIx(owner, s.publicKey, TOPUP_LAMPORTS)]); toast('New session key registered'); await load() } catch (e) { forgetSession(owner); setError(explainGameError(e)) } finally { setBusy(null) } }}>New key</button>
              </div>
            )}
            <hr className="hr" />
            <h3>CRUMB</h3>
            <div className="num">{fmtCrumb(crumbBalance)} <span className="muted small">in wallet</span></div>
            <div className="num">{fmtCrumb(player.claimable)} <span className="muted small">claimable</span></div>
            {yesterday && (
              <p className="small muted">Yesterday: {fmtCookies(player.pendingCookiesMilli)} cookies and {fmtInt(Number(player.pendingClicks))} clicks against a pool of {fmtCrumb(yesterday.pool)} CRUMB. Settle to bank your share.</p>
            )}
            <div className="row" style={{ marginTop: '.5rem' }}>
              {yesterday && <button className="btn sm primary" disabled={!!busy || !session} onClick={settle}><IconRefresh /> Settle</button>}
              <button className="btn sm" disabled={!!busy || !session || player.claimable === 0n} onClick={claim}><IconDownload /> Claim</button>
            </div>
            {busy && <p className="muted small" style={{ marginTop: '.4rem' }}>{busy}</p>}
          </aside>
        </div>
      </section>

      <section className="card">
        <h2>Bakers</h2>
        <p className="lead">Each one bakes while you are away. Every extra unit costs 15% more.</p>
        <div className="bakers">
          {Array.from({ length: TIERS }, (_, t) => {
            const price = tierPriceMilli(t, player.owned[t])
            const can = liveCookies >= price && !!session
            return (
              <div className="baker" key={t}>
                <div>
                  <div className="row" style={{ gap: '.5rem' }}><b>{TIER_NAMES[t]}</b><span className="muted small">{fmtCps(TIER_CPS_MILLI[t])}/s each</span>{player.owned[t] > 0 && <span className="pill">{player.owned[t]}</span>}</div>
                  <div className="small muted">{TIER_LINES[t]}</div>
                </div>
                <button className="btn sm" disabled={!can || !!busy} onClick={() => buy(t)}>{fmtCookies(price)}</button>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h2>Leaderboard</h2>
          <span className="muted small">{rank ? `You are #${rank}` : 'You are not in the top 20 yet'}</span>
        </div>
        <div className="tablewrap" style={{ marginTop: '.6rem' }}>
          <table>
            <thead><tr><th>#</th><th>Player</th><th className="right">Lifetime cookies</th><th className="right">Bakers</th><th className="right">Clicks</th></tr></thead>
            <tbody>
              {board.map((p, i) => (
                <tr key={p.owner.toBase58()} className={p.owner.equals(owner) ? 'me' : ''}>
                  <td className="muted num">{i + 1}</td>
                  <td><a className="mono" href={addressUrl(p.owner.toBase58())} target="_blank" rel="noreferrer">{shortAddr(p.owner.toBase58(), 6, 6)}</a>{p.owner.equals(owner) && <span className="pill" style={{ marginLeft: '.4rem' }}>you</span>}</td>
                  <td className="right num">{fmtCookies(p.lifetimeCookiesMilli)}</td>
                  <td className="right num">{fmtInt(p.owned.reduce((a, b) => a + b, 0))}</td>
                  <td className="right num">{fmtInt(Number(p.lifetimeClicks))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tiles" style={{ marginTop: '1rem' }}>
          <div className="tile"><div className="label">Players</div><div className="value num">{fmtInt(Number(game.players))}</div></div>
          <div className="tile"><div className="label">Clicks on chain</div><div className="value num">{fmtInt(Number(game.totalClicks))}</div></div>
          <div className="tile"><div className="label">CRUMB minted</div><div className="value num">{fmtAmount(emission.minted, CRUMB_DECIMALS, true)}</div></div>
          <div className="tile"><div className="label">Pool today</div><div className="value num">{fmtAmount(math.poolNow, CRUMB_DECIMALS, true)}</div></div>
        </div>
        <p className="small muted" style={{ marginTop: '.6rem' }}>
          {distributor ? `${distributor.weightBps / 100}% of the daily pool goes to this game. ` : ''}Halving {math.tranche} of many: the pool halves when minted supply reaches {fmtAmount(math.nextHalvingAt, CRUMB_DECIMALS, true)} CRUMB.
          {' '}<button className="btn quiet sm" onClick={() => onSnapshot(game.crumbMint.toBase58())}><IconUsers /> Snapshot CRUMB holders</button>
        </p>
        <p className="small muted">Every click, purchase and claim is a transaction you can open on Cookiescan. {feed.find((f) => f.sig) && <a href={txUrl(feed.find((f) => f.sig)!.sig!)} target="_blank" rel="noreferrer">Latest click</a>}</p>
      </section>
    </>
  )
}

const CLICK_CAP_MSG = 'Daily click cap reached. Bakers keep baking; come back tomorrow.'

function entryBurn(g: GameState): bigint {
  if (g.players < g.freeSlots) return 0n
  const steps = Number((g.players - g.freeSlots) / 100n)
  let b = g.entryBurnBase
  for (let i = 0; i < Math.min(steps, 200); i++) b = (b * 110n) / 100n
  return b
}

function CookieArt({ big = false }: { big?: boolean }) {
  const r = big ? 96 : 40
  const chips: [number, number, number][] = [[-0.35, -0.3, 0.14], [0.3, -0.42, 0.11], [0.42, 0.22, 0.15], [-0.1, 0.45, 0.12], [-0.5, 0.2, 0.1], [0.05, -0.02, 0.1]]
  return (
    <svg className={big ? 'cookie-big' : 'art'} viewBox={`0 0 ${r * 2.4} ${r * 2.4}`} aria-hidden="true">
      <circle cx={r * 1.2} cy={r * 1.2} r={r * 1.15} fill="none" stroke="var(--line-strong)" strokeWidth={1.25} strokeDasharray="3 7" />
      <circle cx={r * 1.2} cy={r * 1.2} r={r} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={2} />
      {chips.map(([dx, dy, dr], i) => <circle key={i} cx={r * 1.2 + dx * r} cy={r * 1.2 + dy * r} r={dr * r} fill="var(--accent)" />)}
    </svg>
  )
}

