import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import type { SnapshotResult } from './Snapshot'
import { BatchList } from './BatchList'
import { toast } from './Toast'
import { addressUrl, isPubkey } from '../lib/chain'
import { download } from '../lib/download'
import { fmtInt, shortAddr } from '../lib/format'
import { looksLikeName, resolveNames } from '../lib/names'
import { runBatches } from '../lib/txs'
import { fmtBytes, prepareImage, type PreparedImage } from '../mint/image'
import { DEFAULT_ROYALTY_BPS, DESCRIPTION_LIMIT, MAX_PIECES, NAME_LIMIT, ROYALTY_MAX_BPS, SYMBOL_MAX, deriveSymbol, estimate, fetchRents, pieceName, type DropForm, type Estimate, type Rents } from '../mint/plan'
import { forgetDrop, loadDrop, newDrop, refundDrop, runDrop, saveDrop, type DropState, type Progress } from '../mint/engine'
import { renderDropCard } from '../mint/dropcard'
import { planCreatorVerify, type VerifyPlan } from '../mint/verify'
import { IconChevronDown, IconCopy, IconExternalLink, IconRefresh, IconShare2, IconShieldCheck, IconUsers } from '../icons'

type Dest = 'me' | 'holders' | 'list'
type Phase = 'form' | 'confirm' | 'running' | 'done'

const GAS_LINK = 'https://t.me/TheCookieNetChain'
const BAZAAR = 'https://bakedbazaar.art'
const SLACK = 20_000_000n // 0.02 COOK kept back for fees after the drop
const approx = (n: bigint) => (Number(n) / 1e9).toFixed(n < 100_000_000n ? 2 : 1)

interface Props {
  snapshot: SnapshotResult | null
  onNeedSnapshot: () => void
  /** Opens the Snapshot tab on a collection. */
  onSnapshot: (mint: string) => void
}

export function Mint({ snapshot, onNeedSnapshot, onSnapshot }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const owner = wallet.publicKey

  const [image, setImage] = useState<PreparedImage | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const [busyImage, setBusyImage] = useState(false)
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [symbolInput, setSymbolInput] = useState('')
  const [symbolTouched, setSymbolTouched] = useState(false)
  const symbol = symbolTouched ? symbolInput : name.trim() ? deriveSymbol(name) : ''
  const [description, setDescription] = useState('')
  const [royaltyUi, setRoyaltyUi] = useState(String(DEFAULT_ROYALTY_BPS / 100))
  const [more, setMore] = useState(false)

  const [countUi, setCountUi] = useState('1')
  const [dest, setDest] = useState<Dest>('me')
  const [list, setList] = useState('')
  const [listResult, setListResult] = useState<{ recipients: string[]; errors: string[] }>({ recipients: [], errors: [] })

  const [rents, setRents] = useState<Rents | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [phase, setPhase] = useState<Phase>('form')
  const [drop, setDrop] = useState<DropState | null>(null)
  const [pending, setPending] = useState<DropState | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // what is on screen, readable from the wallet-change effect without re-running it on every render
  const screen = useRef({ phase: 'form' as Phase, drop: null as DropState | null })
  /** Keyed by collection, so a plan read for an earlier drop is never shown for the next one. */
  const [verify, setVerify] = useState<{ collection: string; plan: VerifyPlan | null; error: string | null } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [, setVerifyTick] = useState(0)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    fetchRents(connection).then(setRents).catch(() => setRents(null))
  }, [connection])

  const refreshBalance = useCallback(async () => {
    if (!owner) return setBalance(null)
    try {
      setBalance(BigInt(await connection.getBalance(owner, 'confirmed')))
    } catch {
      setBalance(null)
    }
  }, [connection, owner])
  useEffect(() => {
    refreshBalance()
  }, [refreshBalance])

  // an unfinished drop from an earlier visit resumes; a finished one keeps its done screen until Mint another.
  // A drop in flight keeps its screen whatever the wallet does; another wallet's finished drop leaves it.
  useEffect(() => {
    screen.current = { phase, drop }
  }, [phase, drop])
  useEffect(() => {
    if (!owner || phase === 'running') return
    const saved = loadDrop(owner)
    const onScreen = screen.current.drop
    setPending(saved && saved.stage !== 'done' ? saved : null)
    if (saved && saved.stage === 'done') {
      if (onScreen?.collection.mint !== saved.collection.mint) {
        setDrop(saved)
        setPhase('done')
      }
    } else if (onScreen && onScreen.owner !== owner.toBase58()) {
      setDrop(null)
      setPhase('form')
    }
  }, [owner, phase])

  // which of a finished drop's pieces still list the creator unverified; only the creator's own wallet can tell
  useEffect(() => {
    if (phase !== 'done' || !drop || !owner || drop.creatorVerified || drop.owner !== owner.toBase58()) return
    let stale = false
    const s = drop
    planCreatorVerify(connection, owner, [s.collection.mint, ...s.pieces.map((p) => p.mint)])
      .then((v) => {
        if (stale) return
        if (!v.unverified && !v.missing && v.verified) {
          const done = { ...s, creatorVerified: true }
          saveDrop(done)
          setDrop(done)
        } else setVerify({ collection: s.collection.mint, plan: v, error: null })
      })
      .catch((e) => !stale && setVerify({ collection: s.collection.mint, plan: null, error: (e as Error).message }))
    return () => {
      stale = true
    }
  }, [phase, drop, owner, connection])

  // resolve the pasted list: addresses as they are, .cook names through the name service
  useEffect(() => {
    if (dest !== 'list') return
    const lines = list.split(/\r?\n/).map((l) => l.trim().split(/[,\s;]+/)[0]).filter(Boolean)
    let cancelled = false
    const run = async () => {
      const errors: string[] = []
      const names = lines.filter((l) => !isPubkey(l) && looksLikeName(l))
      let resolved = new Map<string, PublicKey | null>()
      if (names.length) {
        try {
          resolved = await resolveNames(connection, names)
        } catch {
          errors.push('Could not look up .cook names right now.')
        }
      }
      const out: string[] = []
      const seen = new Set<string>()
      for (const l of lines) {
        let addr: string | null = null
        if (isPubkey(l)) addr = new PublicKey(l).toBase58()
        else if (looksLikeName(l)) {
          const pk = resolved.get(l) ?? null
          if (pk) addr = pk.toBase58()
          else errors.push(`${l} is not a registered name`)
        } else errors.push(`${l} is not an address or a .cook name`)
        if (addr && !seen.has(addr)) {
          seen.add(addr)
          out.push(addr)
        }
      }
      if (!cancelled) setListResult({ recipients: out.slice(0, MAX_PIECES), errors })
    }
    const t = setTimeout(run, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [dest, list, connection])

  const holders = useMemo(() => (snapshot ? snapshot.holders.filter((h) => !h.isProgram && !h.frozen).map((h) => h.owner).slice(0, MAX_PIECES) : []), [snapshot])

  const recipients: string[] = useMemo(() => {
    if (!owner) return []
    if (dest === 'holders') return holders
    if (dest === 'list') return listResult.recipients
    const n = Math.min(MAX_PIECES, Math.max(1, Math.floor(Number(countUi) || 1)))
    return Array.from({ length: n }, () => owner.toBase58())
  }, [owner, dest, holders, listResult, countUi])
  const count = recipients.length

  const royaltyBps = Math.round(Math.min(ROYALTY_MAX_BPS / 100, Math.max(0, Number(royaltyUi) || 0)) * 100)
  const form: DropForm = { name: name.trim(), symbol: symbol.trim().toUpperCase().slice(0, SYMBOL_MAX), description: description.trim().slice(0, DESCRIPTION_LIMIT), royaltyBps }
  const nameTooLong = form.name.length > NAME_LIMIT
  const nameOk = form.name.length > 0 && !nameTooLong && form.symbol.length >= 2
  const est: Estimate | null = useMemo(() => (rents && image && count > 0 ? estimate(rents, form, image.bytes.length, image.mime, count) : null), [rents, image, count, form.name, form.symbol, form.description, royaltyBps]) // eslint-disable-line react-hooks/exhaustive-deps
  const need = est ? est.total + SLACK : 50_000_000n
  const enough = balance !== null && balance >= need
  const shortfall = balance !== null && !enough ? need - balance : 0n
  const thingsLeft = (image ? 0 : 1) + (nameOk ? 0 : 1) + (enough ? 0 : 1)
  const canMint = !!owner && !!wallet.signTransaction && thingsLeft === 0 && count > 0 && !!est

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setImageError(null)
    setBusyImage(true)
    try {
      if (image) URL.revokeObjectURL(image.previewUrl)
      setImage(await prepareImage(file))
    } catch (e) {
      setImage(null)
      setImageError((e as Error).message)
    } finally {
      setBusyImage(false)
    }
  }

  const start = async (state: DropState) => {
    if (!owner || !wallet.signTransaction) return
    setDrop(state)
    setPending(null)
    setRunError(null)
    setPhase('running')
    try {
      await runDrop(connection, { publicKey: owner, signTransaction: wallet.signTransaction, signAllTransactions: wallet.signAllTransactions }, state, { onProgress: setProgress })
      setPhase('done')
      toast(`${state.pieces.length} piece${state.pieces.length === 1 ? '' : 's'} minted`)
    } catch (e) {
      setRunError((e as Error).message)
    }
    refreshBalance()
  }

  const confirm = () => {
    if (!owner || !image) return
    start(newDrop(owner, form, recipients.map((r) => new PublicKey(r)), image))
  }

  const discard = async (state: DropState) => {
    try {
      const back = await refundDrop(connection, state)
      if (back > 0n) toast(`${approx(back)} COOK went back to your wallet`)
    } catch {
      // nothing left to refund, or the RPC is away; the key is forgotten either way
    }
    if (pending && pending.owner === state.owner) setPending(null)
    reset()
  }

  const reset = () => {
    if (owner) forgetDrop(owner)
    setDrop(null)
    setProgress(null)
    setRunError(null)
    setPhase('form')
    setImage(null)
    setName('')
    setSymbolTouched(false)
    setDescription('')
    setCountUi('1')
    setDest('me')
    setList('')
  }

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast('Copied'))

  /** The drop's own picture, whatever the form holds by now. */
  const pictureOf = (s: DropState) => `data:${s.image.mime};base64,${s.image.b64}`

  /** The drop as a 1200x630 card: shared where the browser can share files, saved as a PNG elsewhere. */
  const share = async (s: DropState) => {
    setSharing(true)
    let blob: Blob
    try {
      blob = await renderDropCard({
        name: s.form.name,
        symbol: s.form.symbol,
        pieces: s.pieces.length,
        royaltyBps: s.form.royaltyBps,
        collection: s.collection.mint,
        image: pictureOf(s),
        createdAt: s.createdAt,
        site: location.host + (import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')),
      })
    } catch (e) {
      toast('Could not render the card: ' + (e as Error).message)
      setSharing(false)
      return
    }
    const file = new File([blob], `${s.form.symbol.toLowerCase() || 'nft'}-drop.png`, { type: 'image/png' })
    const url = addressUrl(s.collection.mint)
    const text = `${s.form.name}: ${s.pieces.length} piece${s.pieces.length === 1 ? '' : 's'} on Cookie Chain, minted with Crumbs.`
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: s.form.name, text, url })
        return
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // the share sheet refused (activation lapsed, no target): the card still exists, so save it instead
    } finally {
      setSharing(false)
    }
    download(blob, file.name)
    const copied = await navigator.clipboard.writeText(`${text} ${url}`).then(() => true, () => false)
    toast(copied ? 'Share card saved as PNG, text copied' : 'Share card saved as PNG')
  }

  /** Sign every piece that still lists the creator unverified; the wallet signs, nothing else changes. */
  const verifyCreator = async (plan: VerifyPlan, retry: boolean) => {
    if (!owner || !wallet.signTransaction || !drop) return
    setVerifying(true)
    try {
      await runBatches({
        connection,
        signer: { publicKey: owner, signTransaction: wallet.signTransaction, signAllTransactions: wallet.signAllTransactions },
        batches: plan.batches,
        only: retry ? ['failed', 'expired'] : ['pending'],
        onUpdate: () => setVerifyTick((t) => t + 1),
      })
      // the drop on screen may have changed while the wallet was signing (Mint another); only that drop is marked
      if (plan.unverified > 0 && plan.batches.every((b) => b.status === 'confirmed') && screen.current.drop?.collection.mint === drop.collection.mint) {
        const done = { ...drop, creatorVerified: true }
        saveDrop(done)
        setDrop(done)
        toast('You are now the verified creator of every piece')
      }
    } finally {
      setVerifying(false)
    }
  }

  // ---------- running and done ----------
  if (phase === 'running' || phase === 'done') {
    const s = drop!
    const p = progress
    const v = verify?.collection === s.collection.mint ? verify : null
    const vp = v?.plan ?? null
    const vFailed = !!vp?.batches.some((b) => b.status === 'failed' || b.status === 'expired')
    const total = s.pieces.length
    const piecesDone = p?.piecesDone ?? 0
    return (
      <section className="card mint-run">
        {phase === 'done' ? (
          <div className="mint">
            <div>
              <h2>Done. {fmtInt(total)} piece{total === 1 ? ' is' : 's are'} in {dest === 'me' && s.recipients.every((r) => r === s.owner) ? 'your wallet' : 'their wallets'}.</h2>
              <p className="lead">The collection is live on Cookie Chain. What was left of the funding went back to your wallet.</p>
              <div className="row" style={{ gap: '1rem' }}>
                <img className="thumb" src={pictureOf(s)} alt="" />
                <div>
                  <div style={{ fontWeight: 600 }}>{s.form.name}</div>
                  <div className="muted small mono">Collection {shortAddr(s.collection.mint, 4, 4)} <button className="chip" onClick={() => copy(s.collection.mint)}><IconCopy /> copy</button></div>
                </div>
              </div>
              <ul className="links">
                <li><a href={addressUrl(s.collection.mint)} target="_blank" rel="noreferrer">See it on Cookiescan <IconExternalLink /></a></li>
                <li><a href={`${BAZAAR}/nft/${s.pieces[0].mint}`} target="_blank" rel="noreferrer">See it on Baked Bazaar <IconExternalLink /></a></li>
                <li><button className="linkbtn" disabled={sharing} onClick={() => share(s)}>{sharing ? 'Rendering the card…' : 'Share a card'} <IconShare2 /></button></li>
              </ul>
              <div className="verify">
                {s.creatorVerified ? (
                  <div className="ink2 small row" style={{ gap: '0.4rem' }}><IconShieldCheck style={{ color: 'var(--accent)' }} /> You are the verified creator of every piece.</div>
                ) : vp && !vp.unverified ? (
                  <div className="muted small">{fmtInt(vp.missing)} of the pieces {vp.missing === 1 ? 'does' : 'do'} not list this wallet as creator, so there is nothing to sign here.</div>
                ) : vp ? (
                  <>
                    <div style={{ fontWeight: 600 }}>Verify yourself as the creator</div>
                    <div className="muted small" style={{ marginTop: '0.3rem' }}>
                      {fmtInt(vp.unverified)} of {fmtInt(vp.unverified + vp.verified + vp.missing)} still list your wallet as an unverified creator, the collection included: {fmtInt(vp.unverified)} signature{vp.unverified === 1 ? '' : 's'} in {fmtInt(vp.batches.length)} transaction{vp.batches.length === 1 ? '' : 's'}, approved in your wallet. Marketplaces then show a verified creator.
                    </div>
                    <div className="row" style={{ marginTop: '0.7rem' }}>
                      {!vFailed && <button className="btn primary" disabled={verifying || !wallet.signTransaction} onClick={() => verifyCreator(vp, false)}><IconShieldCheck /> {verifying ? 'Working…' : 'Sign and verify'}</button>}
                      {vFailed && !verifying && <button className="btn primary" onClick={() => verifyCreator(vp, true)}><IconRefresh /> Retry failed</button>}
                    </div>
                    {vp.batches.some((b) => b.status !== 'pending') && <div style={{ marginTop: '0.7rem' }}><BatchList batches={vp.batches} unit="signatures" /></div>}
                  </>
                ) : v?.error ? (
                  <div className="limit">Could not read the creator flags: {v.error}</div>
                ) : (
                  <div className="muted small">Checking the creator flag on each piece…</div>
                )}
              </div>
              <div className="row" style={{ marginTop: '1rem' }}>
                <button className="btn" onClick={() => onSnapshot(s.collection.mint)}><IconUsers /> Snapshot the holders</button>
                <button className="btn" disabled={verifying} onClick={reset}>Mint another</button>
              </div>
            </div>
            <div className="side">
              <NftCard src={pictureOf(s)} name={pieceName(s.form.name, total)} line={`${s.form.name} · ${s.form.symbol} · ${total} of ${total}`} />
              <div className="muted small" style={{ textAlign: 'center', marginTop: '0.5rem' }}>The last piece, as its owner sees it.</div>
            </div>
          </div>
        ) : (
          <div className="mint">
            <div>
              <h2>{s.stage === 'store' ? 'Storing the picture' : 'Minting'}</h2>
              {p?.prompt ? (
                <div className="sheet">
                  <div style={{ fontWeight: 600 }}>Your wallet is asking you to approve “{p.prompt}”.</div>
                  <div className="muted small" style={{ marginTop: '0.3rem' }}>Nothing moves until you do. Rejecting it sends nothing.</div>
                </div>
              ) : null}
              {s.stage === 'store' || (p && p.stage === 'store') ? (
                <div className="stage">
                  <Bar label="Picture on Cookie Chain" done={p?.chunksDone ?? 0} total={p?.chunksTotal ?? 1} unit="chunks" />
                  <Bar label={`Labels for ${fmtInt(total)} piece${total === 1 ? '' : 's'}`} done={p?.labelsDone ?? 0} total={p?.labelsTotal ?? total + 1} unit="stored" />
                  <div className="muted small">About twenty seconds for a picture this size. Chunks that fail are sent again by themselves.</div>
                </div>
              ) : (
                <div className="stage">
                  <Bar label={s.collection.done ? 'Pieces' : 'Collection first, then the pieces'} done={piecesDone} total={total} unit="minted" />
                  <div className="muted small">No more wallet prompts. Failed pieces are sent again by themselves.</div>
                </div>
              )}
              {p?.note && <div className="muted small" style={{ marginTop: '0.5rem' }}>{p.note}</div>}
              {runError && (
                <div className="sheet" style={{ marginTop: '1rem' }}>
                  <div style={{ fontWeight: 600 }}>Stopped: {runError}</div>
                  <div className="muted small" style={{ marginTop: '0.3rem' }}>Nothing is lost. Finished parts stay finished and resume continues from there.</div>
                  <div className="row" style={{ marginTop: '0.7rem' }}>
                    <button className="btn primary" onClick={() => start(s)}>Resume</button>
                    <button className="btn" onClick={() => discard(s)}>Discard</button>
                  </div>
                </div>
              )}
              {!runError && <div className="muted small" style={{ marginTop: '1rem' }}>Closing the tab is safe. Finished pieces stay minted and you can resume the rest.</div>}
            </div>
            <div className="side">
              <NftCard src={pictureOf(s)} name={pieceName(s.form.name, Math.min(total, piecesDone + 1))} line={`${s.form.name} · ${s.form.symbol} · ${Math.min(total, piecesDone + 1)} of ${total}`} />
            </div>
          </div>
        )}
      </section>
    )
  }

  // ---------- the form ----------
  const previewName = form.name ? pieceName(form.name, 1) : 'Untitled #1'
  const mintLabel = !owner
    ? 'Connect your wallet to mint'
    : thingsLeft > 0 && !(image && nameOk && !enough)
      ? 'Mint'
      : !enough
        ? `You need ${approx(shortfall)} more COOK`
        : `Mint ${fmtInt(count)} piece${count === 1 ? '' : 's'}`

  return (
    <section className="card">
      {pending && (
        <div className="sheet" style={{ marginBottom: '1.2rem' }}>
          <div style={{ fontWeight: 600 }}>You have an unfinished drop</div>
          <div className="muted small" style={{ marginTop: '0.3rem' }}>
            {pending.form.name}, {fmtInt(pending.pieces.filter((x) => x.done).length)} of {fmtInt(pending.pieces.length)} pieces minted, stopped {ago(pending.updatedAt)}. Resume continues where it stopped. Nothing is minted twice.
          </div>
          <div className="row" style={{ marginTop: '0.7rem' }}>
            <button className="btn primary" onClick={() => start(pending)}>Resume</button>
            <button className="btn" onClick={() => discard(pending)}>Discard</button>
          </div>
        </div>
      )}
      <div className={`mint${phase === 'confirm' ? ' confirming' : ''}`}>
        <div className={phase === 'confirm' ? 'locked' : ''}>
          <div className="sec">
            <div className="t">Picture</div>
            {image ? (
              <div className="row" style={{ gap: '1rem', alignItems: 'flex-start' }}>
                <img className="thumb" src={image.previewUrl} alt="" />
                <div>
                  <div>{image.width} × {image.height} {image.mime === 'image/webp' ? 'WebP' : 'JPG'}, {fmtBytes(image.bytes.length)}. Looks good.</div>
                  {image.note && <div className="muted small">{image.note}</div>}
                  <div className="muted small">Stored on Cookie Chain for about {est ? approx(est.image) : rents ? approx(rents.blobBase + rents.blobPerByte * BigInt(image.bytes.length)) : '…'} COOK. <button className="linkbtn" onClick={() => fileInput.current?.click()}>Replace</button></div>
                </div>
              </div>
            ) : (
              <label
                className={`dropzone${over ? ' over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setOver(true) }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]) }}
              >
                {busyImage ? 'Preparing…' : 'Drop a picture here, or click to choose'}
                <small>PNG, JPG, GIF or WebP up to 10 MB. Square looks best. Every piece shows this picture.</small>
                <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            )}
            {image && <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} />}
            {imageError && <div className="limit" style={{ marginTop: '0.5rem' }}>{imageError}</div>}
          </div>

          <div className="sec">
            <div className="t">Name</div>
            <input className="input" placeholder="Cookie Club Pass" value={name} maxLength={NAME_LIMIT + 10} onChange={(e) => setName(e.target.value)} />
            {nameTooLong ? (
              <div className="limit" style={{ marginTop: '0.4rem' }}>{NAME_LIMIT} characters at most, so the number fits.</div>
            ) : (
              <div className="muted small" style={{ marginTop: '0.4rem' }}>
                {form.name ? <>Pieces get numbered: {pieceName(form.name, 1)}, #2, #3 … Ticker {form.symbol || '…'}.</> : 'Pieces get numbered: Name #1, #2, #3 …'}
                {form.name.length >= NAME_LIMIT - 6 && <> {form.name.length}/{NAME_LIMIT}</>}
              </div>
            )}
          </div>

          <div className="sec">
            <div className="t">How many, and who gets them</div>
            <div className="row" style={{ marginBottom: '0.6rem' }}>
              <button className="chip" aria-pressed={dest === 'me'} onClick={() => setDest('me')}>My wallet</button>
              <button className="chip" aria-pressed={dest === 'holders'} onClick={() => (snapshot ? setDest('holders') : onNeedSnapshot())} title={snapshot ? '' : 'Take a snapshot first'}>
                {snapshot ? `Holders of ${snapshot.token.symbol} · ${fmtInt(holders.length)}` : 'Holders of a token'}
              </button>
              <button className="chip" aria-pressed={dest === 'list'} onClick={() => setDest('list')}>A list</button>
            </div>
            {dest === 'me' && (
              <div className="row">
                <input className="input num" style={{ width: 110 }} inputMode="numeric" value={countUi} onChange={(e) => setCountUi(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => setCountUi(String(count))} />
                <span className="muted small">Up to {fmtInt(MAX_PIECES)} per drop. Keep them, list them on Baked Bazaar, or send them later with Airdrop.</span>
              </div>
            )}
            {dest === 'holders' && snapshot && (
              <div className="muted small">
                One piece per wallet, straight from the snapshot: {fmtInt(holders.length)} {snapshot.token.symbol} holders{snapshot.holders.length > holders.length ? `, pools and frozen accounts left out` : ''}{holders.length >= MAX_PIECES ? `, first ${fmtInt(MAX_PIECES)}` : ''}.{' '}
                <button className="linkbtn" onClick={onNeedSnapshot}>Different token</button>
              </div>
            )}
            {dest === 'list' && (
              <>
                <textarea className="input" spellCheck={false} placeholder={'8xk3…Wq9d\nalice.cook\n9Hq2…Zt7c'} value={list} onChange={(e) => setList(e.target.value)} />
                <div className="muted small" style={{ marginTop: '0.4rem' }}>One address or .cook name per line, one piece each. {listResult.recipients.length ? `${fmtInt(listResult.recipients.length)} wallets.` : ''}</div>
                {listResult.errors.slice(0, 3).map((e) => <div className="limit" key={e}>{e}</div>)}
              </>
            )}
          </div>

          <div className="sec">
            <button className="btn" onClick={() => setMore(!more)} aria-expanded={more}><IconChevronDown style={{ transform: more ? 'rotate(180deg)' : undefined }} /> {more ? 'Fewer options' : 'More options'}</button>
            {!more && <span className="muted small" style={{ marginLeft: '0.7rem' }}>ticker {form.symbol || '…'}, {form.description ? 'description set' : 'no description'}, royalty {royaltyUi || 0}%</span>}
            {more && (
              <div className="grid2" style={{ marginTop: '0.9rem' }}>
                <label className="field">
                  <span>Ticker</span>
                  <input className="input" value={symbol} maxLength={SYMBOL_MAX} onChange={(e) => { setSymbolTouched(true); setSymbolInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')) }} />
                  <span>2 to 10 letters. Filled in from the name.</span>
                </label>
                <label className="field">
                  <span>Royalty</span>
                  <input className="input num" inputMode="decimal" value={royaltyUi} onChange={(e) => setRoyaltyUi(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <span>Percent paid to you when a piece is resold on a marketplace that honours it. 0 to 50.</span>
                </label>
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span>Description <span className="pill">optional</span></span>
                  <input className="input" placeholder="What is this for? Shown in wallets and on Baked Bazaar." value={description} maxLength={DESCRIPTION_LIMIT} onChange={(e) => setDescription(e.target.value)} />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="side">
          {phase === 'confirm' ? (
            <div className="sheet">
              <div style={{ fontWeight: 600 }}>Mint {fmtInt(count)} piece{count === 1 ? '' : 's'} to {dest === 'me' ? 'your wallet' : `${fmtInt(count)} wallets`}?</div>
              <div className="muted small" style={{ marginTop: '0.4rem' }}>Your wallet will ask you once, to fund the drop with about {est ? approx(est.total) : '…'} COOK. Storing and minting then run by themselves.</div>
              <div className="muted small" style={{ marginTop: '0.3rem' }}>The picture and names are final. Every piece ends up with you as its update authority. Crumbs can change nothing afterwards.</div>
              <div className="row" style={{ marginTop: '0.8rem' }}>
                <button className="btn" onClick={() => setPhase('form')}>Back</button>
                <button className="btn primary" onClick={confirm}>Yes, mint</button>
              </div>
            </div>
          ) : (
            <>
              <NftCard src={image?.previewUrl ?? null} name={previewName} line={form.name ? `${form.name} · ${form.symbol} · 1 of ${fmtInt(count)}` : 'Collection · ticker'} dim={!image} />
              <ul className="checks">
                <li className={image ? 'ok' : ''}>Picture</li>
                <li className={nameOk ? 'ok' : ''}>Name</li>
                <li className={enough ? 'ok' : ''}>Enough COOK{balance !== null ? ` (${approx(balance)})` : ''}</li>
              </ul>
              <div className="costbox">
                {est ? (
                  <>
                    <div className="row between"><span>Picture on chain</span><span>{approx(est.image)} COOK</span></div>
                    <div className="row between"><span>{fmtInt(count)} piece{count === 1 ? '' : 's'}</span><span>{approx(est.pieces + est.labels + est.fees)} COOK</span></div>
                    <div className="row between total"><span>Total</span><span>about {approx(est.total)} COOK</span></div>
                  </>
                ) : (
                  <div className="row between"><span>Cost</span><span className="muted">shown when the picture is in</span></div>
                )}
              </div>
              <button className="btn primary wide" style={{ marginTop: '0.9rem' }} disabled={!canMint} onClick={() => setPhase('confirm')}>{mintLabel}</button>
              <div className="muted small" style={{ textAlign: 'center', marginTop: '0.4rem' }}>
                {!owner ? 'Free. Your wallet signs every transaction.' : !enough && image && nameOk ? <>Ask for gas in the <a href={GAS_LINK} target="_blank" rel="noreferrer">Cookie Chain Telegram</a>.</> : thingsLeft > 0 ? `${thingsLeft} thing${thingsLeft === 1 ? '' : 's'} left` : 'Permanent. You approve once in your wallet.'}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function NftCard({ src, name, line, dim }: { src: string | null; name: string; line: string; dim?: boolean }) {
  return (
    <div className="nftcard">
      {src ? <img src={src} alt="" /> : <div className="blank" />}
      <div className="nm" style={{ color: dim ? 'var(--muted)' : undefined }}>{name}</div>
      <div className="cl">{line}</div>
    </div>
  )
}

function Bar({ label, done, total, unit }: { label: string; done: number; total: number; unit: string }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="prog-row">
      <div className="prog"><i style={{ width: `${pct}%` }} /></div>
      <div className="row between muted small"><span>{label}</span><span className="num">{fmtInt(done)} of {fmtInt(total)} {unit}</span></div>
    </div>
  )
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}
