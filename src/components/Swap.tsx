import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { buildOfferTx, cancelIx, createNonceIxs, decodeOffer, encodeOffer, offerFromHash, offerIsOpen, offerLink, readNonce, rememberNonce, resolveLeg, savedNonce, simulateOffer, type Leg, type Offer } from '../swap/offer'
import { fetchOwnedAccounts, type OwnedAccount } from '../lib/revoke'
import { loadRegistry, searchRegistry, type TokenInfo } from '../lib/tokens'
import { COOK_DECIMALS, COOK_MINT, addressUrl, isPubkey, txUrl } from '../lib/chain'
import { fmtAmount, shortAddr } from '../lib/format'
import { explainError } from '../lib/txs'
import { toast } from './Toast'
import { IconArrowRight, IconCheck, IconCopy, IconLink, IconX } from '../icons'

/** Peer-to-peer swap as a link: maker signs first against a durable nonce, taker signs and sends. */
export function Swap() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const owner = wallet.publicKey
  const [registry, setRegistry] = useState<Map<string, TokenInfo>>(new Map())
  const [owned, setOwned] = useState<OwnedAccount[]>([])
  const [cookBalance, setCookBalance] = useState<bigint>(0n)
  const [incoming, setIncoming] = useState<{ encoded: string; offer?: Offer; open?: boolean; error?: string; sim?: { ok: boolean; reason?: string } } | null>(() => {
    const e = offerFromHash()
    return e ? { encoded: e } : null
  })
  // create form
  const [giveMint, setGiveMint] = useState(COOK_MINT)
  const [giveAmt, setGiveAmt] = useState('')
  const [getQuery, setGetQuery] = useState('')
  const [getMint, setGetMint] = useState('')
  const [getAmt, setGetAmt] = useState('')
  const [taker, setTaker] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ link: string; offer: Offer } | null>(null)
  const [nonceState, setNonceState] = useState<'none' | 'ready' | 'busy'>('none')

  useEffect(() => {
    loadRegistry().then(setRegistry).catch(() => {})
  }, [])
  useEffect(() => {
    if (!owner) return
    fetchOwnedAccounts(connection, owner).then((a) => setOwned(a.filter((x) => x.amount > 0n))).catch(() => {})
    connection.getBalance(owner).then((b) => setCookBalance(BigInt(b))).catch(() => {})
    const n = savedNonce(owner)
    if (n) readNonce(connection, n).then((acc) => setNonceState(acc ? (acc.nonce ? 'busy' : 'ready') : 'none')).catch(() => setNonceState('none'))
  }, [owner, connection, made])

  // decode an incoming offer once
  useEffect(() => {
    if (!incoming || incoming.offer || incoming.error) return
    try {
      const offer = decodeOffer(incoming.encoded)
      Promise.all([offerIsOpen(connection, offer), simulateOffer(connection, offer)])
        .then(([open, sim]) => setIncoming({ encoded: incoming.encoded, offer, open, sim }))
        .catch(() => setIncoming({ encoded: incoming.encoded, offer, open: false }))
    } catch (e) {
      setIncoming({ encoded: incoming.encoded, error: (e as Error).message })
    }
  }, [incoming, connection])

  const giveOptions = useMemo(() => {
    const opts = [{ mint: COOK_MINT, label: `COOK · ${fmtAmount(cookBalance, COOK_DECIMALS)}`, decimals: COOK_DECIMALS }]
    for (const a of owned) opts.push({ mint: a.mint, label: `${registry.get(a.mint)?.symbol || a.mint.slice(0, 6) + '…'} · ${fmtAmount(a.amount, a.decimals)}`, decimals: a.decimals })
    return opts
  }, [owned, registry, cookBalance])
  const getSuggestions = useMemo(() => (isPubkey(getQuery) ? [] : searchRegistry(registry, getQuery, 6)), [registry, getQuery])
  const sym = (mint: string) => (mint === COOK_MINT ? 'COOK' : registry.get(mint)?.symbol || shortAddr(mint, 4, 4))

  async function signAndSend(tx: Transaction, extraSigners: Keypair[] = []) {
    if (!owner || !wallet.signTransaction) throw new Error('Wallet cannot sign')
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.feePayer = owner
    tx.recentBlockhash = blockhash
    if (extraSigners.length) tx.partialSign(...extraSigners)
    const signed = await wallet.signTransaction(tx)
    const sig = await connection.sendRawTransaction(signed.serialize())
    const r = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    if (r.value.err) throw new Error(`On-chain error ${JSON.stringify(r.value.err)}`)
    return sig
  }

  async function ensureNonce(): Promise<PublicKey> {
    if (!owner) throw new Error('Connect a wallet')
    const existing = savedNonce(owner)
    if (existing && (await readNonce(connection, existing))) return existing
    setBusy('Creating your offer slot (one time, about 0.0015 COOK)…')
    const kp = Keypair.generate()
    const tx = new Transaction().add(...(await createNonceIxs(connection, owner, kp)))
    await signAndSend(tx, [kp])
    rememberNonce(owner, kp.publicKey)
    return kp.publicKey
  }

  async function create() {
    if (!owner || !wallet.signTransaction) return
    setError(null)
    setMade(null)
    try {
      if (!isPubkey(taker)) throw new Error('Enter the counterparty wallet address')
      const takerPk = new PublicKey(taker.trim())
      if (takerPk.equals(owner)) throw new Error('The counterparty is you')
      const mintB = isPubkey(getQuery) ? getQuery.trim() : getMint
      if (!mintB) throw new Error('Pick the token you want')
      const nonceAccount = await ensureNonce()
      setBusy('Building the offer…')
      const give: Leg = await resolveLeg(connection, giveMint, giveAmt)
      const get: Leg = await resolveLeg(connection, mintB, getAmt)
      if (give.amount <= 0n || get.amount <= 0n) throw new Error('Amounts must be above zero')
      const n = await readNonce(connection, nonceAccount)
      if (!n) throw new Error('Offer slot not found; try again')
      const tx = buildOfferTx(owner, takerPk, give, get, nonceAccount, n.nonce)
      setBusy('Waiting for your wallet…')
      const signed = await wallet.signTransaction(tx)
      const encoded = encodeOffer(signed)
      const offer = decodeOffer(encoded) // proves the link is valid before showing it
      setMade({ link: offerLink(encoded), offer })
      toast('Offer signed. Share the link with the counterparty.')
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(null)
    }
  }

  async function cancel(nonceAccount: PublicKey) {
    if (!owner) return
    setBusy('Cancelling…')
    try {
      await signAndSend(new Transaction().add(cancelIx(owner, nonceAccount)))
      setMade(null)
      toast('Offer cancelled. Any copy of the link is now void.')
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(null)
    }
  }

  async function accept() {
    if (!incoming?.offer || !owner || !wallet.signTransaction) return
    const o = incoming.offer
    if (!o.taker.equals(owner)) return setError(`This offer is addressed to ${shortAddr(o.taker.toBase58())}. Connect that wallet.`)
    setBusy('Waiting for your wallet…')
    setError(null)
    try {
      const signed = await wallet.signTransaction(o.tx)
      setBusy('Sending…')
      const sig = await connection.sendRawTransaction(signed.serialize())
      const r = await connection.confirmTransaction({ signature: sig, blockhash: o.nonce, lastValidBlockHeight: (await connection.getBlockHeight()) + 150 }, 'confirmed')
      if (r.value.err) throw new Error(`On-chain error ${JSON.stringify(r.value.err)}`)
      toast('Swap done')
      setIncoming({ ...incoming, open: false })
      history.replaceState(null, '', location.pathname)
      setMade(null)
      window.open(txUrl(sig), '_blank')
    } catch (e) {
      setError(explainError(e))
    } finally {
      setBusy(null)
    }
  }

  const legText = (l: Leg) => `${fmtAmount(l.amount, l.decimals)} ${sym(l.mint)}`

  return (
    <>
      {incoming && (
        <section className="card">
          <h2>Offer received</h2>
          {incoming.error && <p className="err">This link is not a valid Crumbs offer: {incoming.error}</p>}
          {incoming.offer && (
            <>
              <div className="tiles" style={{ margin: '.75rem 0' }}>
                <div className="tile"><div className="label">You receive</div><div className="value num">{legText(incoming.offer.give)}</div></div>
                <div className="tile"><div className="label">You send</div><div className="value num">{legText(incoming.offer.get)}</div></div>
                <div className="tile"><div className="label">From</div><div className="value mono" style={{ fontSize: '1rem' }}>{shortAddr(incoming.offer.maker.toBase58(), 6, 6)}</div></div>
                <div className="tile"><div className="label">Status</div><div className="value" style={{ fontSize: '1rem' }}>{incoming.open === undefined ? 'checking…' : !incoming.open ? 'taken or cancelled' : incoming.sim?.ok ? 'open, ready' : 'open, would fail'}</div></div>
              </div>
              {incoming.sim && !incoming.sim.ok && <p className="err small">{incoming.sim.reason}</p>}
              <p className="small muted">Both transfers happen in one transaction or not at all. You pay the network fee and any token account rent (about 0.002 COOK each). The maker already signed; nothing moves until you sign.</p>
              <div className="row" style={{ marginTop: '.8rem' }}>
                <button className="btn primary" disabled={!!busy || !incoming.open || !owner} onClick={accept}><IconCheck /> {owner ? 'Sign and swap' : 'Connect the counterparty wallet'}</button>
                <button className="btn quiet" onClick={() => { setIncoming(null); history.replaceState(null, '', location.pathname) }}><IconX /> Dismiss</button>
                {busy && <span className="muted">{busy}</span>}
              </div>
              {error && <p className="err small">{error}</p>}
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Swap by link</h2>
        <p className="lead">Trade any two tokens with one wallet, no escrow, no pool. You sign your side once; the other wallet opens the link, sees exactly what moves, and signs theirs. One transaction, all or nothing.</p>
        {!owner ? (
          <p className="muted small">Connect a wallet to make an offer.</p>
        ) : (
          <>
            <div className="grid2">
              <label className="field">
                <span>You give</span>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <select className="input" value={giveMint} onChange={(e) => setGiveMint(e.target.value)}>
                    {giveOptions.map((o) => <option key={o.mint} value={o.mint}>{o.label}</option>)}
                  </select>
                  <input className="input num" style={{ maxWidth: 140 }} inputMode="decimal" placeholder="amount" value={giveAmt} onChange={(e) => setGiveAmt(e.target.value)} />
                </div>
              </label>
              <label className="field" style={{ position: 'relative' }}>
                <span>You get</span>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input className="input mono" placeholder="symbol or mint" value={getQuery} onChange={(e) => { setGetQuery(e.target.value); setGetMint('') }} spellCheck={false} />
                  <input className="input num" style={{ maxWidth: 140 }} inputMode="decimal" placeholder="amount" value={getAmt} onChange={(e) => setGetAmt(e.target.value)} />
                </div>
                {getSuggestions.length > 0 && !getMint && (
                  <div className="menu" style={{ left: 0, right: 'auto', top: '100%', minWidth: 280 }}>
                    <button onClick={() => { setGetMint(COOK_MINT); setGetQuery('COOK') }}>COOK <span className="muted">native</span></button>
                    {getSuggestions.map((t) => <button key={t.mint} onClick={() => { setGetMint(t.mint); setGetQuery(t.symbol) }}>{t.logo && <img src={t.logo} alt="" />}{t.symbol} <span className="muted">{t.name}</span></button>)}
                  </div>
                )}
              </label>
            </div>
            <label className="field" style={{ marginTop: '.8rem' }}>
              <span>Counterparty wallet</span>
              <input className="input mono" placeholder="The wallet that will take this offer" value={taker} onChange={(e) => setTaker(e.target.value)} spellCheck={false} />
            </label>
            <div className="row" style={{ marginTop: '1rem' }}>
              <button className="btn primary" disabled={!!busy || !giveAmt || !getAmt || !taker} onClick={create}><IconLink /> {busy ?? 'Sign and make the link'}</button>
              {nonceState !== 'none' && savedNonce(owner) && <button className="btn quiet" disabled={!!busy} onClick={() => cancel(savedNonce(owner)!)}>Cancel my open offer</button>}
              {error && <span className="err">{error}</span>}
            </div>
            <p className="small muted" style={{ marginTop: '.6rem' }}>Offers are addressed to one wallet. Anyone else opening the link sees the terms but cannot take it. One open offer per wallet at a time; making a new one voids the previous link.</p>
          </>
        )}
        {made && (
          <div className="notice" style={{ marginTop: '1rem' }}>
            <div className="row between">
              <b>Offer ready</b>
              <span className="small muted">{legText(made.offer.give)} <IconArrowRight /> {legText(made.offer.get)} with <a className="mono" href={addressUrl(made.offer.taker.toBase58())} target="_blank" rel="noreferrer">{shortAddr(made.offer.taker.toBase58(), 6, 6)}</a></span>
            </div>
            <div className="row" style={{ marginTop: '.5rem' }}>
              <input className="input mono small" readOnly value={made.link} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={() => navigator.clipboard.writeText(made.link).then(() => toast('Offer link copied'))}><IconCopy /> Copy link</button>
            </div>
          </div>
        )}
      </section>
    </>
  )
}
