import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { BatchList } from './BatchList'
import { ArtCleanup } from './Art'
import { IconBrush, IconRefresh } from '../icons'
import { closeItem, fetchOwnedAccounts, packCleanup, revokeItem, type OwnedAccount } from '../lib/revoke'
import { loadRegistry, type TokenInfo } from '../lib/tokens'
import { runBatches, type Batch } from '../lib/txs'
import { COOK_DECIMALS, addressUrl } from '../lib/chain'
import { fmtAmount, fmtInt, shortAddr } from '../lib/format'

/** Revoke delegates and close empty token accounts. The rent comes back to you, no fee taken. */
export function Cleanup() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [accounts, setAccounts] = useState<OwnedAccount[] | null>(null)
  const [registry, setRegistry] = useState<Map<string, TokenInfo>>(new Map())
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [batches, setBatches] = useState<Batch[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => {})
  }, [])

  const load = useCallback(() => {
    if (!wallet.publicKey) return
    setAccounts(null)
    fetchOwnedAccounts(connection, wallet.publicKey).then(setAccounts).catch((e) => setError((e as Error).message))
  }, [connection, wallet.publicKey])

  useEffect(load, [load])

  const delegated = useMemo(() => (accounts ?? []).filter((a) => a.delegate), [accounts])
  const empty = useMemo(() => (accounts ?? []).filter((a) => a.amount === 0n && !a.frozen), [accounts])
  const reclaim = empty.filter((a) => picked.has(a.address)).reduce((n, a) => n + a.rent, 0n)

  const sym = (mint: string) => registry.get(mint)?.symbol || shortAddr(mint, 4, 4)

  function toggle(addr: string) {
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(addr)) n.delete(addr)
      else n.add(addr)
      return n
    })
  }

  async function run() {
    if (!wallet.publicKey || !wallet.signTransaction) return
    const owner = wallet.publicKey
    const items = [
      ...delegated.filter((a) => picked.has(a.address)).map((a) => revokeItem(a, owner)),
      ...empty.filter((a) => picked.has(a.address)).map((a) => closeItem(a, owner)),
    ]
    if (!items.length) return
    const bs = packCleanup(owner, items)
    setBatches(bs)
    setRunning(true)
    setError(null)
    try {
      await runBatches({
        connection,
        signer: { publicKey: owner, signTransaction: wallet.signTransaction, signAllTransactions: wallet.signAllTransactions },
        batches: bs,
        onUpdate: () => setBatches([...bs]),
      })
    } finally {
      setRunning(false)
      setPicked(new Set())
      load()
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="card empty">
        <div>
          <h2>Cleanup</h2>
          <p className="lead">Revoke token delegates you do not recognise and close empty token accounts to get their rent back. Nothing is skimmed.</p>
          <p className="muted small">Connect a wallet to start.</p>
        </div>
        <ArtCleanup />
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <div className="row between">
          <div>
            <h2>Delegations</h2>
            <p className="lead">Accounts where another address may move your tokens. Revoke what you do not recognise.</p>
          </div>
          <button className="btn sm" onClick={load} disabled={accounts === null}><IconRefresh /> Refresh</button>
        </div>
        {accounts === null ? (
          <p className="muted">Loading token accounts…</p>
        ) : delegated.length === 0 ? (
          <p className="muted">No active delegations. Nothing to revoke.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>Token</th><th>Delegate</th><th className="right">Allowance</th></tr></thead>
              <tbody>
                {delegated.map((a) => (
                  <tr key={a.address}>
                    <td><input type="checkbox" checked={picked.has(a.address)} onChange={() => toggle(a.address)} style={{ accentColor: 'var(--accent)' }} /></td>
                    <td>{sym(a.mint)}</td>
                    <td><a className="mono" href={addressUrl(a.delegate!)} target="_blank" rel="noreferrer">{shortAddr(a.delegate!, 6, 6)}</a></td>
                    <td className="right num">{fmtAmount(a.delegatedAmount, a.decimals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <div>
            <h2>Empty token accounts</h2>
            <p className="lead">Each one holds {fmtAmount(2_039_280n, COOK_DECIMALS)} COOK of rent. Closing returns it to you, no fee taken.</p>
          </div>
          {empty.length > 0 && (
            <button className="btn sm" onClick={() => setPicked(new Set([...picked, ...empty.map((a) => a.address)]))}>Select all {fmtInt(empty.length)}</button>
          )}
        </div>
        {accounts === null ? (
          <p className="muted">Loading…</p>
        ) : empty.length === 0 ? (
          <p className="muted">No empty token accounts. Your wallet is tidy.</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>Token</th><th>Account</th><th className="right">Rent</th></tr></thead>
              <tbody>
                {empty.map((a) => (
                  <tr key={a.address}>
                    <td><input type="checkbox" checked={picked.has(a.address)} onChange={() => toggle(a.address)} style={{ accentColor: 'var(--accent)' }} /></td>
                    <td>{sym(a.mint)} {!a.isAta && <span className="pill">not an ATA</span>}</td>
                    <td><a className="mono" href={addressUrl(a.address)} target="_blank" rel="noreferrer">{shortAddr(a.address, 6, 6)}</a></td>
                    <td className="right num">{fmtAmount(a.rent, COOK_DECIMALS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row" style={{ marginTop: '1rem' }}>
          <button className="btn primary" disabled={running || picked.size === 0 || !wallet.signTransaction} onClick={run}>
            <IconBrush /> {running ? 'Working…' : `Sign and run ${fmtInt(picked.size)} action${picked.size === 1 ? '' : 's'}`}
          </button>
          {reclaim > 0n && <span className="ink2">Reclaims {fmtAmount(reclaim, COOK_DECIMALS)} COOK</span>}
          {error && <span className="err">{error}</span>}
        </div>
        {batches.length > 0 && <div style={{ marginTop: '1rem' }}><BatchList batches={batches} unit="actions" /></div>}
          {batches.some((b) => b.status === 'signing') && <p className="small muted" style={{ marginTop: '0.6rem' }}>Waiting on the wallet. If it shows a failed simulation, its network is not Cookie Chain: in Nightly open the network switcher, pick Cookie, then retry.</p>}
      </section>
    </>
  )
}
