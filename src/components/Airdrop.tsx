import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import type { SnapshotResult } from './Snapshot'
import { BatchList } from './BatchList'
import { planAirdrop, parseRecipientList, proRata, resolveAsset, type AirdropPlan, type Asset, type Recipient } from '../lib/airdrop'
import { fetchOwnedAccounts, type OwnedAccount } from '../lib/revoke'
import { loadRegistry, type TokenInfo } from '../lib/tokens'
import { runBatches, type Batch } from '../lib/txs'
import { COOK_DECIMALS, COOK_MINT } from '../lib/chain'
import { fmtAmount, fmtInt, uiToRaw } from '../lib/format'

interface Props {
  snapshot: SnapshotResult | null
  onNeedSnapshot: () => void
}

type Source = 'snapshot' | 'list'
type Mode = 'fixed' | 'prorata'

export function Airdrop({ snapshot, onNeedSnapshot }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [owned, setOwned] = useState<OwnedAccount[]>([])
  const [registry, setRegistry] = useState<Map<string, TokenInfo>>(new Map())
  const [cookBalance, setCookBalance] = useState<bigint>(0n)
  const [assetMint, setAssetMint] = useState(COOK_MINT)
  const [source, setSource] = useState<Source>(snapshot ? 'snapshot' : 'list')
  const [mode, setMode] = useState<Mode>('fixed')
  const [amountUi, setAmountUi] = useState('')
  const [list, setList] = useState('')
  const [topN, setTopN] = useState('')
  const [minUi, setMinUi] = useState('')
  const [skipProgram, setSkipProgram] = useState(true)
  const [skipSelf, setSkipSelf] = useState(true)
  const [plan, setPlan] = useState<AirdropPlan | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => {})
  }, [])

  useEffect(() => {
    if (!wallet.publicKey) return
    const pk = wallet.publicKey
    fetchOwnedAccounts(connection, pk).then((a) => setOwned(a.filter((x) => x.amount > 0n))).catch(() => {})
    connection.getBalance(pk).then((b) => setCookBalance(BigInt(b))).catch(() => {})
  }, [wallet.publicKey, connection, batches])

  const assetOptions = useMemo(() => {
    const opts = [{ mint: COOK_MINT, label: `COOK · ${fmtAmount(cookBalance, COOK_DECIMALS)}`, decimals: COOK_DECIMALS, balance: cookBalance }]
    for (const a of owned) {
      const t = registry.get(a.mint)
      opts.push({ mint: a.mint, label: `${t?.symbol || a.mint.slice(0, 6) + '…'} · ${fmtAmount(a.amount, a.decimals)}`, decimals: a.decimals, balance: a.amount })
    }
    return opts
  }, [owned, registry, cookBalance])
  const asset = assetOptions.find((o) => o.mint === assetMint) ?? assetOptions[0]

  const snapshotRows = useMemo(() => {
    if (!snapshot) return []
    const min = minUi.trim() ? BigInt(Math.floor(Number(minUi) * 10 ** snapshot.token.decimals)) : 0n
    let rows = snapshot.holders.filter((h) => (!skipProgram || !h.isProgram) && h.amount >= min && !h.frozen)
    if (skipSelf && wallet.publicKey) rows = rows.filter((h) => h.owner !== wallet.publicKey!.toBase58())
    const n = parseInt(topN, 10)
    if (n > 0) rows = rows.slice(0, n)
    return rows
  }, [snapshot, minUi, skipProgram, skipSelf, topN, wallet.publicKey])

  async function makePlan() {
    if (!wallet.publicKey) return
    setError(null)
    setPlan(null)
    setBatches([])
    setBusy('Planning…')
    try {
      const resolved: Asset = await resolveAsset(connection, asset.mint, registry.get(asset.mint)?.symbol)
      const toRaw = (ui: string) => uiToRaw(ui, resolved.decimals)
      let recipients: Recipient[]
      if (source === 'snapshot') {
        if (!snapshotRows.length) throw new Error('The snapshot has no holders after filtering.')
        if (!amountUi.trim()) throw new Error('Enter an amount.')
        const amt = toRaw(amountUi)
        recipients = mode === 'fixed' ? snapshotRows.map((h) => ({ owner: h.owner, amount: amt })) : proRata(amt, snapshotRows.map((h) => ({ owner: h.owner, weight: h.amount })))
      } else {
        const def = amountUi.trim() ? toRaw(amountUi) : undefined
        const parsed = parseRecipientList(list, toRaw, def)
        if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 3).join('; ') + (parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3} more)` : ''))
        recipients = parsed.recipients
        if (!recipients.length) throw new Error('Paste at least one address.')
      }
      const p = await planAirdrop(connection, wallet.publicKey, resolved, recipients)
      if (!p.recipients.length) throw new Error('No valid recipients.')
      setPlan(p)
      setBatches(p.batches)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
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
    const lines = ['owner,amount,batch,status,signature']
    let i = 0
    for (const b of plan.batches) for (let k = 0; k < b.items.length; k++, i++) lines.push(`${plan.recipients[i].owner},${fmtAmount(plan.recipients[i].amount, plan.asset.decimals).replace(/,/g, '')},${b.id},${b.status},${b.signature ?? ''}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `airdrop-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (!wallet.publicKey) {
    return (
      <section className="card">
        <h2>Airdrop</h2>
        <p className="lead">Send COOK or any token to a holder snapshot or a pasted list. Connect a wallet to start.</p>
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <h2>Airdrop</h2>
        <p className="lead">Batched transfers, one wallet prompt, live confirmations. Missing token accounts are created for the recipients.</p>

        <div className="grid2">
          <label className="field">
            <span>Send</span>
            <select className="input" value={asset.mint} onChange={(e) => setAssetMint(e.target.value)}>
              {assetOptions.map((o) => (
                <option key={o.mint} value={o.mint}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{source === 'snapshot' ? (mode === 'fixed' ? 'Amount per wallet' : 'Total to split pro-rata') : 'Default amount per line (optional)'}</span>
            <input className="input num" inputMode="decimal" placeholder="0" value={amountUi} onChange={(e) => setAmountUi(e.target.value)} />
          </label>
        </div>

        <hr className="hr" />
        <div className="row between">
          <div className="seg" role="group" aria-label="Recipients">
            <button aria-pressed={source === 'snapshot'} onClick={() => setSource('snapshot')}>Snapshot holders</button>
            <button aria-pressed={source === 'list'} onClick={() => setSource('list')}>Pasted list</button>
          </div>
          {source === 'snapshot' && (
            <div className="seg" role="group" aria-label="Amount mode">
              <button aria-pressed={mode === 'fixed'} onClick={() => setMode('fixed')}>Same for everyone</button>
              <button aria-pressed={mode === 'prorata'} onClick={() => setMode('prorata')}>Pro-rata to holdings</button>
            </div>
          )}
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
                <label className="field"><span>Min {snapshot.token.symbol} balance</span><input className="input num" inputMode="decimal" placeholder="0" value={minUi} onChange={(e) => setMinUi(e.target.value)} /></label>
                <label className="field"><span>Top N holders only</span><input className="input num" inputMode="numeric" placeholder="all" value={topN} onChange={(e) => setTopN(e.target.value)} /></label>
              </div>
            </div>
          ) : (
            <div className="notice" style={{ marginTop: '0.9rem' }}>
              No snapshot yet. <button className="btn quiet" onClick={onNeedSnapshot}>Take one</button> or paste a list.
            </div>
          )
        ) : (
          <label className="field" style={{ marginTop: '0.9rem' }}>
            <span>One recipient per line: address, then an optional amount</span>
            <textarea className="input" spellCheck={false} placeholder={'8xk3…Wq9d, 100\n5Fjr…Lm2a, 250\n9Hq2…Zt7c'} value={list} onChange={(e) => setList(e.target.value)} />
          </label>
        )}

        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="btn primary" disabled={!!busy || running} onClick={makePlan}>Preview</button>
          {busy && <span className="muted">{busy}</span>}
          {error && <span className="err">{error}</span>}
        </div>
      </section>

      {plan && (
        <section className="card">
          <h2>Review</h2>
          <div className="tiles" style={{ margin: '0.75rem 0' }}>
            <div className="tile"><div className="label">Recipients</div><div className="value num">{fmtInt(plan.recipients.length)}</div></div>
            <div className="tile"><div className="label">Total {plan.asset.symbol}</div><div className="value num">{fmtAmount(plan.totalAmount, plan.asset.decimals, true)}</div></div>
            <div className="tile"><div className="label">Transactions</div><div className="value num">{plan.batches.length}</div></div>
            <div className="tile"><div className="label">Rent for new accounts</div><div className="value num">{fmtAmount(plan.rentLamports, COOK_DECIMALS)} COOK</div></div>
          </div>
          <p className="small muted">
            {plan.ataCreates > 0 && <>{fmtInt(plan.ataCreates)} recipients get a new token account, paid by you and reclaimable by them. </>}
            Network fees about {fmtAmount(plan.feeLamports, COOK_DECIMALS)} COOK.
            {plan.invalid.length > 0 && <> {plan.invalid.length} invalid address{plan.invalid.length > 1 ? 'es' : ''} skipped.</>}
          </p>
          {shortfall && shortfall.length > 0 && <div className="notice err" style={{ marginTop: '0.75rem' }}>{shortfall.join(' ')}</div>}

          <div className="row" style={{ margin: '1rem 0' }}>
            {!done && !canRetry && (
              <button className="btn primary" disabled={running || (shortfall?.length ?? 0) > 0 || !wallet.signTransaction} onClick={() => send(false)}>
                {running ? 'Working…' : `Sign and send ${plan.batches.length} transaction${plan.batches.length > 1 ? 's' : ''}`}
              </button>
            )}
            {canRetry && !running && <button className="btn primary" onClick={() => send(true)}>Retry failed</button>}
            {done && <span className="ink2">Done. {fmtInt(sentRecipients)} wallets received {plan.asset.symbol}.</span>}
            {batches.some((b) => b.signature) && <button className="btn" onClick={exportResults}>Export results</button>}
          </div>
          <BatchList batches={batches} unit="recipients" />
          {batches.some((b) => b.status === 'signing') && <p className="small muted" style={{ marginTop: '0.6rem' }}>Waiting on the wallet. If it shows a failed simulation, its network is not Cookie Chain: in Nightly open the network switcher, pick Cookie, then retry.</p>}
        </section>
      )}
      {wallet.publicKey && !PublicKey.isOnCurve(wallet.publicKey.toBytes()) && <div className="notice">Connected key is off-curve; use a normal wallet.</div>}
    </>
  )
}
