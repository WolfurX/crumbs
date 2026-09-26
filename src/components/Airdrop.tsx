import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { SnapshotResult } from './Snapshot'
import { fetchHolders } from '../lib/das'
import { CRUMB_MINT } from '../game/constants'
import { BatchList } from './BatchList'
import { ArtAirdrop } from './Art'
import { toast } from './Toast'
import { nftAsset, planAirdrop, parseRecipientList, proRata, resolveAsset, type AirdropPlan, type Asset, type Recipient } from '../lib/airdrop'
import { looksLikeName, resolveNames } from '../lib/names'
import { fetchWalletNfts, type NftGroup, type WalletNfts } from '../lib/nfts'
import { fetchOwnedAccounts, type OwnedAccount } from '../lib/revoke'
import { loadRegistry, type TokenInfo } from '../lib/tokens'
import { runBatches, type Batch } from '../lib/txs'
import { COOK_DECIMALS, COOK_MINT, isPubkey, txUrl } from '../lib/chain'
import { fmtAmount, fmtInt, shortAddr, uiToRaw } from '../lib/format'
import { loadAirdrops, recordAirdrop } from '../lib/history'
import { timeAgo } from '../lib/recent'
import { IconArrowRight, IconCheck, IconCoins, IconDownload, IconParachute, IconRefresh } from '../icons'

interface Props {
  snapshot: SnapshotResult | null
  onNeedSnapshot: () => void
  onSnapshot: (r: SnapshotResult) => void
}

type Source = 'snapshot' | 'list'
type Mode = 'fixed' | 'prorata'
type Step = 1 | 2 | 3

/** What the Send menu offers: COOK, each token in the wallet, and each NFT collection in it. */
type AssetOption =
  | { key: string; kind: 'fungible'; mint: string; label: string; decimals: number; balance: bigint }
  | { key: string; kind: 'nft'; group: NftGroup; label: string; decimals: 0; balance: bigint }
const nftKey = (g: NftGroup) => `nft:${g.collection}`

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Recipients' },
  { n: 2, label: 'Amount' },
  { n: 3, label: 'Review and send' },
]

export function Airdrop({ snapshot, onNeedSnapshot, onSnapshot }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [step, setStep] = useState<Step>(1)
  const [owned, setOwned] = useState<OwnedAccount[]>([])
  const [nfts, setNfts] = useState<WalletNfts>({ groups: [], mints: new Set() })
  const [registry, setRegistry] = useState<Map<string, TokenInfo>>(new Map())
  const [cookBalance, setCookBalance] = useState<bigint>(0n)
  const [assetKey, setAssetKey] = useState(COOK_MINT)
  const [source, setSource] = useState<Source>(snapshot ? 'snapshot' : 'list')
  const [mode, setMode] = useState<Mode>('fixed')
  const [amountUi, setAmountUi] = useState('')
  const [list, setList] = useState('')
  const [topN, setTopN] = useState('')
  const [exclude, setExclude] = useState('')
  const [minUi, setMinUi] = useState('')
  const [skipProgram, setSkipProgram] = useState(true)
  const [skipSelf, setSkipSelf] = useState(true)
  const [plan, setPlan] = useState<AirdropPlan | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState(() => loadAirdrops())
  const planId = useRef(0)

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => {})
  }, [])

  useEffect(() => {
    if (!wallet.publicKey) return
    const pk = wallet.publicKey
    fetchOwnedAccounts(connection, pk).then((a) => setOwned(a.filter((x) => x.amount > 0n))).catch(() => {})
    connection.getBalance(pk).then((b) => setCookBalance(BigInt(b))).catch(() => {})
  }, [wallet.publicKey, connection, batches])

  // the wallet's NFTs, grouped by collection, from the same token accounts; not while a run is refetching them per batch
  useEffect(() => {
    if (running) return
    let stale = false
    fetchWalletNfts(connection, owned).then((g) => !stale && setNfts(g)).catch(() => {})
    return () => {
      stale = true
    }
  }, [owned, connection, running])

  const locked = running || batches.some((b) => b.status !== 'pending')

  // a new snapshot from another tab becomes the recipients and restarts the steps
  useEffect(() => {
    if (!snapshot || locked) return
    setSource('snapshot')
    setPlan(null)
    setBatches([])
    setStep(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.takenAt])

  /** Addresses on the exclude list; .cook names on it are resolved when the plan is made. */
  const excludeSet = useMemo(() => new Set(exclude.split(/\r?\n/).map((l) => l.trim()).filter(isPubkey)), [exclude])
  const excludeNames = useMemo(() => exclude.split(/\r?\n/).map((l) => l.trim()).filter(looksLikeName), [exclude])

  const assetOptions = useMemo(() => {
    const opts: AssetOption[] = [{ key: COOK_MINT, kind: 'fungible', mint: COOK_MINT, label: `COOK · ${fmtAmount(cookBalance, COOK_DECIMALS)}`, decimals: COOK_DECIMALS, balance: cookBalance }]
    for (const a of owned) {
      if (nfts.mints.has(a.mint)) continue
      const t = registry.get(a.mint)
      opts.push({ key: a.mint, kind: 'fungible', mint: a.mint, label: `${t?.symbol || a.mint.slice(0, 6) + '…'} · ${fmtAmount(a.amount, a.decimals)}`, decimals: a.decimals, balance: a.amount })
    }
    for (const g of nfts.groups) opts.push({ key: nftKey(g), kind: 'nft', group: g, label: `${g.name} · ${fmtInt(g.pieces.length)} piece${g.pieces.length === 1 ? '' : 's'}`, decimals: 0, balance: BigInt(g.pieces.length) })
    return opts
  }, [owned, nfts, registry, cookBalance])
  const asset = assetOptions.find((o) => o.key === assetKey) ?? assetOptions[0]
  const nft = asset.kind === 'nft'

  const snapshotRows = useMemo(() => {
    if (!snapshot) return []
    const min = minUi.trim() ? BigInt(Math.floor(Number(minUi) * 10 ** snapshot.token.decimals)) : 0n
    let rows = snapshot.holders.filter((h) => (!skipProgram || !h.isProgram) && h.amount >= min && !h.frozen && !excludeSet.has(h.owner))
    if (skipSelf && wallet.publicKey) rows = rows.filter((h) => h.owner !== wallet.publicKey!.toBase58())
    const n = parseInt(topN, 10)
    if (n > 0) rows = rows.slice(0, n)
    return rows
  }, [snapshot, minUi, skipProgram, skipSelf, topN, excludeSet, wallet.publicKey])

  const listCount = useMemo(() => list.split(/\r?\n/).filter((l) => l.trim()).length, [list])

  /** Snapshot every CRUMB holder and make them the recipients, one click. */
  async function crumbHolders() {
    setBusy('Fetching CRUMB holders…')
    setError(null)
    try {
      const mint = CRUMB_MINT.toBase58()
      const holders = await fetchHolders(mint, (n) => setBusy(`Fetching CRUMB holders… ${fmtInt(n)} accounts`))
      const total = holders.reduce((n, h) => n + h.amount, 0n)
      const token = registry.get(mint) ?? { mint, symbol: 'CRUMB', name: 'Crumb', decimals: 6 }
      onSnapshot({ token: { ...token, symbol: 'CRUMB' }, holders, total, takenAt: Date.now() })
      setSource('snapshot')
      if (!holders.length) setError('Nobody holds CRUMB yet. Claims from the clicker settle after each UTC day.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const recipientCount = source === 'snapshot' ? snapshotRows.length : listCount

  async function makePlan() {
    if (!wallet.publicKey) return
    setError(null)
    setPlan(null)
    setBatches([])
    setBusy('Planning…')
    try {
      const resolved: Asset = asset.kind === 'nft' ? nftAsset(asset.group) : await resolveAsset(connection, asset.mint, registry.get(asset.mint)?.symbol)
      // an NFT drop is one piece per wallet: amounts on the lines are ignored
      const toRaw = resolved.kind === 'nft' ? () => 1n : (ui: string) => uiToRaw(ui, resolved.decimals)
      let recipients: Recipient[]
      if (source === 'snapshot') {
        if (!snapshotRows.length) throw new Error('The snapshot has no holders after filtering.')
        if (resolved.kind === 'nft') recipients = snapshotRows.map((h) => ({ owner: h.owner, amount: 1n }))
        else {
          if (!amountUi.trim()) throw new Error('Enter an amount.')
          const amt = toRaw(amountUi)
          recipients = mode === 'fixed' ? snapshotRows.map((h) => ({ owner: h.owner, amount: amt })) : proRata(amt, snapshotRows.map((h) => ({ owner: h.owner, weight: h.amount })))
        }
      } else {
        const def = resolved.kind === 'nft' ? 1n : amountUi.trim() ? toRaw(amountUi) : undefined
        const parsed = parseRecipientList(list, toRaw, def)
        if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 3).join('; ') + (parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3} more)` : ''))
        recipients = parsed.recipients
        if (!recipients.length) throw new Error('Paste at least one address.')
        const named = recipients.filter((r) => looksLikeName(r.owner))
        if (named.length) {
          setBusy('Resolving .cook names…')
          const found = await resolveNames(connection, named.map((r) => r.owner))
          const missing = named.filter((r) => !found.get(r.owner)).map((r) => r.owner.trim())
          if (missing.length) throw new Error(`Not registered as .cook names: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`)
          recipients = recipients.map((r) => ({ ...r, owner: found.get(r.owner)?.toBase58() ?? r.owner }))
        }
      }
      if (excludeSet.size || excludeNames.length) {
        const drop = new Set(excludeSet)
        if (excludeNames.length) {
          setBusy('Resolving the exclude list…')
          const found = await resolveNames(connection, excludeNames)
          for (const pk of found.values()) if (pk) drop.add(pk.toBase58())
        }
        recipients = recipients.filter((r) => !drop.has(r.owner))
        if (!recipients.length) throw new Error('Every recipient is on the exclude list.')
      }
      const p = await planAirdrop(connection, wallet.publicKey, resolved, recipients)
      planId.current = Date.now()
      if (!p.recipients.length) throw new Error(p.belowRent ? `Every recipient would end up under the ${fmtAmount(p.rentMinimum, COOK_DECIMALS)} COOK rent minimum. Send more per wallet.` : 'No valid recipients.')
      setPlan(p)
      setBatches(p.batches)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function goReview() {
    setStep(3)
    void makePlan()
  }

  async function send(retry = false) {
    if (!plan || !wallet.publicKey || !wallet.signTransaction) return
    setRunning(true)
    setError(null)
    try {
      await runBatches({
        connection,
        signer: { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction, signAllTransactions: wallet.signAllTransactions },
        batches: plan.batches,
        only: retry ? ['failed', 'expired'] : ['pending'],
        onUpdate: () => setBatches([...plan.batches]),
      })
      const ok = plan.batches.filter((b) => b.status === 'confirmed').reduce((n, b) => n + b.items.length, 0)
      if (plan.batches.every((b) => b.status === 'confirmed')) toast(`Airdrop complete: ${fmtInt(ok)} wallet${ok === 1 ? '' : 's'} received ${plan.asset.kind === 'nft' ? `one ${plan.asset.symbol} piece` : plan.asset.symbol}`)
      const signatures = plan.batches.filter((b) => b.status === 'confirmed' && b.signature).map((b) => b.signature!)
      if (signatures.length) {
        // recipients are in batch order, so walk the batches to sum what actually landed
        let total = 0n
        let i = 0
        for (const b of plan.batches) for (let k = 0; k < b.items.length; k++, i++) if (b.status === 'confirmed') total += plan.recipients[i].amount
        setHistory(recordAirdrop({ id: planId.current, at: Date.now(), symbol: plan.asset.symbol, decimals: plan.asset.decimals, total: total.toString(), recipients: ok, signatures, pieces: plan.asset.kind === 'nft' || undefined }))
      }
    } finally {
      setRunning(false)
    }
  }

  const shortfall = useMemo(() => {
    if (!plan) return null
    const cookNeeded = plan.rentLamports + plan.feeLamports + (plan.asset.kind === 'native' ? plan.totalAmount : 0n)
    const notes: string[] = []
    if (cookNeeded > cookBalance) notes.push(`Needs ${fmtAmount(cookNeeded, COOK_DECIMALS)} COOK, wallet has ${fmtAmount(cookBalance, COOK_DECIMALS)}.`)
    if (plan.asset.kind === 'token' && plan.totalAmount > asset.balance) notes.push(`Needs ${fmtAmount(plan.totalAmount, plan.asset.decimals)} ${plan.asset.symbol}, wallet has ${fmtAmount(asset.balance, asset.decimals)}.`)
    return notes
  }, [plan, cookBalance, asset])

  const done = batches.length > 0 && batches.every((b) => b.status === 'confirmed')
  const canRetry = batches.some((b) => b.status === 'failed' || b.status === 'expired')
  const sentRecipients = batches.filter((b) => b.status === 'confirmed').reduce((n, b) => n + b.items.length, 0)

  function exportResults() {
    if (!plan) return
    const lines = [plan.pieces ? 'owner,piece,batch,status,signature' : 'owner,amount,batch,status,signature']
    let i = 0
    for (const b of plan.batches) for (let k = 0; k < b.items.length; k++, i++) lines.push(`${plan.recipients[i].owner},${plan.pieces ? plan.pieces[i].mint : fmtAmount(plan.recipients[i].amount, plan.asset.decimals).replace(/,/g, '')},${b.id},${b.status},${b.signature ?? ''}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `airdrop-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    toast('Results CSV saved')
  }

  function reset() {
    setPlan(null)
    setBatches([])
    setError(null)
    setStep(1)
  }

  if (!wallet.publicKey) {
    return (
      <section className="card empty">
        <div>
          <h2>Airdrop</h2>
          <p className="lead">Send COOK, any token or the NFTs you hold to a holder snapshot or a pasted list. Same amount for everyone, pro-rata, or one piece per wallet, batched into as few transactions as fit, one wallet prompt.</p>
          <p className="muted small">Connect a wallet to start.</p>
        </div>
        <ArtAirdrop />
      </section>
    )
  }

  return (
    <>
      <div className="steps" role="list" aria-label="Airdrop steps">
        {STEPS.map((s) => (
          <button key={s.n} role="listitem" className={`step${s.n < step ? ' done' : ''}`} aria-current={s.n === step ? 'step' : undefined} disabled={locked || (s.n === 3 && step < 3)} onClick={() => !locked && s.n < 3 && setStep(s.n)}>
            <span className="n">{s.n < step ? <IconCheck /> : s.n}</span>
            <span className="label">{s.label}</span>
            {s.n === 1 && step > 1 && <span className="muted num" style={{ marginLeft: 'auto' }}>{fmtInt(recipientCount)}</span>}
            {s.n === 2 && step > 2 && plan && <span className="muted num" style={{ marginLeft: 'auto' }}>{plan.pieces ? `${fmtInt(plan.recipients.length)} piece${plan.recipients.length === 1 ? '' : 's'}` : `${fmtAmount(plan.totalAmount, plan.asset.decimals, true)} ${plan.asset.symbol}`}</span>}
          </button>
        ))}
      </div>

      {step === 1 && (
        <section className="card">
          <h2>Who receives it</h2>
          <p className="lead">A holder snapshot with filters, or a list you paste.</p>
          <div className="row">
            <div className="seg" role="group" aria-label="Recipients">
              <button aria-pressed={source === 'snapshot'} onClick={() => setSource('snapshot')}>Snapshot holders</button>
              <button aria-pressed={source === 'list'} onClick={() => setSource('list')}>Pasted list</button>
            </div>
            <button className="btn" disabled={!!busy} onClick={crumbHolders} title="Snapshot every CRUMB holder and airdrop to them"><IconCoins /> CRUMB holders</button>
            {busy && <span className="muted small">{busy}</span>}
          </div>

          {source === 'snapshot' ? (
            snapshot ? (
              <div className="stack" style={{ marginTop: '0.9rem' }}>
                <div className="ink2">
                  {snapshot.token.symbol} snapshot from {new Date(snapshot.takenAt).toLocaleString()}: <b className="num">{fmtInt(snapshotRows.length)}</b> recipients after filters
                </div>
                <div className="row">
                  <label className="check"><input type="checkbox" checked={skipProgram} onChange={(e) => setSkipProgram(e.target.checked)} /> Skip pools and vaults</label>
                  <label className="check"><input type="checkbox" checked={skipSelf} onChange={(e) => setSkipSelf(e.target.checked)} /> Skip my wallet</label>
                </div>
                <div className="grid2">
                  <label className="field"><span>{snapshot.kind === 'collection' ? 'Min pieces held' : `Min ${snapshot.token.symbol} balance`}</span><input className="input num" inputMode="decimal" placeholder="0" value={minUi} onChange={(e) => setMinUi(e.target.value)} /></label>
                  <label className="field"><span>Top N holders only</span><input className="input num" inputMode="numeric" placeholder="all" value={topN} onChange={(e) => setTopN(e.target.value)} /></label>
                </div>
                <label className="field">
                  <span>Exclude wallets, one per line: address or .cook name (names are checked at review)</span>
                  <textarea className="input" style={{ minHeight: 64 }} spellCheck={false} placeholder={'treasury.cook\n8xk3…Wq9d'} value={exclude} onChange={(e) => setExclude(e.target.value)} />
                </label>
              </div>
            ) : (
              <div className="notice" style={{ marginTop: '0.9rem' }}>
                No snapshot yet. <button className="btn quiet" onClick={onNeedSnapshot}>Take one</button> or paste a list.
              </div>
            )
          ) : (
            <label className="field" style={{ marginTop: '0.9rem' }}>
              <span>One recipient per line: address or .cook name, then an optional amount</span>
              <textarea className="input" spellCheck={false} placeholder={'8xk3…Wq9d, 100\nalice.cook, 250\n9Hq2…Zt7c'} value={list} onChange={(e) => setList(e.target.value)} />
            </label>
          )}

          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn primary" disabled={recipientCount === 0} onClick={() => setStep(2)}>
              Continue with {fmtInt(recipientCount)} recipient{recipientCount === 1 ? '' : 's'} <IconArrowRight />
            </button>
          </div>
          {history.length > 0 && (
            <>
              <hr className="hr" />
              <div className="muted small">Airdrops sent from this browser</div>
              <ul className="history">
                {history.map((h) => (
                  <li key={h.id}>
                    <span className="muted" title={new Date(h.at).toLocaleString()}>{timeAgo(h.at)}</span>
                    <span><b className="num">{fmtInt(h.recipients)}</b> wallet{h.recipients === 1 ? '' : 's'} got <span className="num">{fmtAmount(BigInt(h.total), h.decimals, true)} {h.symbol}{h.pieces ? ` piece${h.total === '1' ? '' : 's'}` : ''}</span></span>
                    <span className="small">
                      <a className="mono" href={txUrl(h.signatures[0])} target="_blank" rel="noreferrer">{shortAddr(h.signatures[0], 4, 4)}</a>
                      {h.signatures.length > 1 && <span className="muted"> +{h.signatures.length - 1} more</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="card">
          <h2>What they get</h2>
          <p className="lead">Pick the asset from your wallet and how the amount is split.</p>
          <div className="grid2">
            <label className="field">
              <span>Send</span>
              <select className="input" value={asset.key} onChange={(e) => setAssetKey(e.target.value)}>
                {nfts.groups.length ? (
                  <>
                    <optgroup label="Tokens">
                      {assetOptions.filter((o) => o.kind === 'fungible').map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </optgroup>
                    <optgroup label="NFT collections, one piece per wallet">
                      {assetOptions.filter((o) => o.kind === 'nft').map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </optgroup>
                  </>
                ) : (
                  assetOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)
                )}
              </select>
            </label>
            {asset.kind === 'nft' ? (
              <div className="field">
                <span>Pieces</span>
                <div className="ink2" style={{ padding: '0.55rem 0' }}>
                  {(() => {
                    // the list is not cleaned until review, so these are bounds; the review shows the exact split
                    const held = asset.group.pieces.length
                    const out = Math.min(recipientCount, held)
                    const over = recipientCount - held
                    return <>Up to <b className="num">{fmtInt(out)}</b> of your {fmtInt(held)} piece{held === 1 ? '' : 's'} go{out === 1 ? 'es' : ''} out, one per wallet{over > 0 ? <>; at most {fmtInt(over)} wallet{over === 1 ? ' is' : 's are'} left out</> : null}. The review shows the exact split.</>
                  })()}
                </div>
              </div>
            ) : (
              <label className="field">
                <span>{source === 'snapshot' ? (mode === 'fixed' ? 'Amount per wallet' : 'Total to split pro-rata') : 'Default amount per line (optional)'}</span>
                <input className="input num" inputMode="decimal" placeholder="0" value={amountUi} onChange={(e) => setAmountUi(e.target.value)} />
              </label>
            )}
          </div>
          {source === 'snapshot' && !nft && (
            <div className="seg" role="group" aria-label="Amount mode" style={{ marginTop: '0.9rem' }}>
              <button aria-pressed={mode === 'fixed'} onClick={() => setMode('fixed')}>Same for everyone</button>
              <button aria-pressed={mode === 'prorata'} onClick={() => setMode('prorata')}>Pro-rata to holdings</button>
            </div>
          )}
          <p className="small muted" style={{ marginTop: '0.9rem' }}>
            {nft ? `One piece per wallet, in piece order (${asset.group.pieces[0]?.name ?? ''} first) and recipient order${source === 'list' ? '; amounts on the lines are ignored' : ''}. Each recipient gets a token account for their piece, paid by you.` : source === 'snapshot' && mode === 'prorata' ? 'The total is split in proportion to each holder’s balance; rounding dust stays with you.' : source === 'snapshot' ? 'Every recipient gets exactly this amount.' : 'Lines without an amount use the default.'}
          </p>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <button className="btn primary" disabled={source === 'snapshot' && !nft && !amountUi.trim()} onClick={goReview}>
              Review <IconArrowRight />
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="card">
          <h2>Review and send</h2>
          {busy && <p className="muted">{busy}</p>}
          {error && <p className="err">{error}</p>}
          {plan && (
            <>
              <div className="tiles" style={{ margin: '0.75rem 0' }}>
                <div className="tile"><div className="label">Recipients</div><div className="value num">{fmtInt(plan.recipients.length)}</div></div>
                {plan.pieces ? (
                  <div className="tile"><div className="label">{plan.asset.symbol} pieces</div><div className="value num">{fmtInt(plan.recipients.length)}</div></div>
                ) : (
                  <div className="tile"><div className="label">Total {plan.asset.symbol}</div><div className="value num">{fmtAmount(plan.totalAmount, plan.asset.decimals, true)}</div></div>
                )}
                <div className="tile"><div className="label">Transactions</div><div className="value num">{plan.batches.length}</div></div>
                <div className="tile"><div className="label">Rent for new accounts</div><div className="value num">{fmtAmount(plan.rentLamports, COOK_DECIMALS)} COOK</div></div>
              </div>
              <p className="small muted">
                {plan.ataCreates > 0 && <>{fmtInt(plan.ataCreates)} recipient{plan.ataCreates === 1 ? ' gets' : 's get'} a new token account, paid by you and reclaimable by them. </>}
                Network fees about {fmtAmount(plan.feeLamports, COOK_DECIMALS)} COOK.
                {plan.invalid.length > 0 && <> {plan.invalid.length} invalid address{plan.invalid.length > 1 ? 'es' : ''} skipped.</>}
                {plan.belowRent > 0 && <> {fmtInt(plan.belowRent)} skipped: an empty wallet cannot receive less than {fmtAmount(plan.rentMinimum, COOK_DECIMALS)} COOK, the chain's rent minimum.</>}
                {plan.withoutPiece > 0 && <> {fmtInt(plan.withoutPiece)} recipient{plan.withoutPiece === 1 ? '' : 's'} left out: you hold {fmtInt(plan.recipients.length)} piece{plan.recipients.length === 1 ? '' : 's'}.</>}
              </p>
              {shortfall && shortfall.length > 0 && <div className="notice err" style={{ marginTop: '0.75rem' }}>{shortfall.join(' ')}</div>}

              <div className="row" style={{ margin: '1rem 0' }}>
                {!locked && <button className="btn" onClick={() => setStep(2)}>Back</button>}
                {!done && !canRetry && (
                  <button className="btn primary" disabled={running || (shortfall?.length ?? 0) > 0 || !wallet.signTransaction} onClick={() => send(false)}>
                    <IconParachute /> {running ? 'Working…' : `Sign and send ${plan.batches.length} transaction${plan.batches.length > 1 ? 's' : ''}`}
                  </button>
                )}
                {canRetry && !running && <button className="btn primary" onClick={() => send(true)}><IconRefresh /> Retry failed</button>}
                {canRetry && !running && <button className="btn quiet" onClick={reset}>Start over</button>}
                {done && <span className="ink2">Done. {fmtInt(sentRecipients)} wallet{sentRecipients === 1 ? '' : 's'} received {plan.pieces ? `one ${plan.asset.symbol} piece` : plan.asset.symbol}.</span>}
                {batches.some((b) => b.signature) && <button className="btn" onClick={exportResults}><IconDownload /> Export results</button>}
                {done && <button className="btn quiet" onClick={reset}>New airdrop</button>}
              </div>
              <BatchList batches={batches} unit="recipients" />
              {batches.some((b) => b.status === 'signing') && <p className="small muted" style={{ marginTop: '0.6rem' }}>Waiting on the wallet. If it shows a failed simulation, its network is not Cookie Chain: in Nightly open the network switcher, pick Cookie, then retry.</p>}
            </>
          )}
          {!plan && !busy && error && (
            <div className="row" style={{ marginTop: '1rem' }}>
              <button className="btn" onClick={() => setStep(2)}>Back</button>
              <button className="btn primary" onClick={() => void makePlan()}><IconRefresh /> Try again</button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
