import { useEffect, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletReadyState } from '@solana/wallet-adapter-base'
import { shortAddr, fmtAmount } from '../lib/format'
import { COOK_DECIMALS, addressUrl } from '../lib/chain'
import { IconCopy, IconExternalLink, IconPlugConnected, IconWallet } from '../icons'

/** Connect menu over the Wallet Standard: every installed wallet shows up, Nightly first. */
export function WalletButton() {
  const { wallets, select, connect, disconnect, publicKey, connecting, wallet } = useWallet()
  const { connection } = useConnection()
  const [open, setOpen] = useState(false)
  const [balance, setBalance] = useState<bigint | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!publicKey) {
      setBalance(null)
      return
    }
    let stop = false
    const load = () => connection.getBalance(publicKey).then((b) => !stop && setBalance(BigInt(b))).catch(() => {})
    load()
    const id = setInterval(load, 15_000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [publicKey, connection])

  const installed = wallets
    .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
    .sort((a, b) => (a.adapter.name === 'Nightly' ? -1 : b.adapter.name === 'Nightly' ? 1 : 0))

  if (publicKey) {
    return (
      <div className="wallet" ref={ref}>
        <button className="btn" onClick={() => setOpen((o) => !o)}>
          {wallet?.adapter.icon && <img src={wallet.adapter.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />}
          <span className="mono">{shortAddr(publicKey.toBase58())}</span>
          {balance !== null && <span className="muted num">{fmtAmount(balance, COOK_DECIMALS, true)} COOK</span>}
        </button>
        {open && (
          <div className="menu">
            <button onClick={() => navigator.clipboard.writeText(publicKey.toBase58()).then(() => setOpen(false))}><IconCopy /> Copy address</button>
            <button onClick={() => window.open(addressUrl(publicKey.toBase58()), '_blank')}><IconExternalLink /> View on Cookiescan</button>
            <button onClick={() => disconnect().then(() => setOpen(false))}><IconPlugConnected /> Disconnect</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="wallet" ref={ref}>
      <button className="btn primary" disabled={connecting} onClick={() => setOpen((o) => !o)}>
        <IconWallet /> {connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="menu">
          {installed.length === 0 && (
            <button onClick={() => window.open('https://nightly.app', '_blank')}>
              No wallet found. Install Nightly
            </button>
          )}
          {installed.map((w) => (
            <button
              key={w.adapter.name}
              onClick={async () => {
                setOpen(false)
                select(w.adapter.name)
                // select() is async under the hood; connect on the next tick once the adapter is set.
                setTimeout(() => connect().catch(() => {}), 0)
              }}
            >
              <img src={w.adapter.icon} alt="" />
              {w.adapter.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
