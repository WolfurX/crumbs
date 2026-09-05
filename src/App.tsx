import { useState } from 'react'
import { WalletButton } from './components/WalletButton'
import { Snapshot, type SnapshotResult } from './components/Snapshot'
import { Airdrop } from './components/Airdrop'
import { Cleanup } from './components/Cleanup'
import { StatStrip } from './components/StatStrip'
import { Toaster } from './components/Toast'
import { Roadmap } from './components/Roadmap'
import { Clicker } from './components/Clicker'
import { Crumb } from './components/Crumb'
import { Swap } from './components/Swap'
import { offerFromHash } from './swap/offer'
import { useInstallPrompt } from './lib/install'
import { IconAperture, IconBrush, IconCoins, IconCookie, IconDownload, IconLink, IconParachute } from './icons'

type Tab = 'snapshot' | 'airdrop' | 'cleanup' | 'swap' | 'clicker' | 'crumb'

const TABS: { id: Tab; label: string; icon: typeof IconAperture }[] = [
  { id: 'snapshot', label: 'Snapshot', icon: IconAperture },
  { id: 'airdrop', label: 'Airdrop', icon: IconParachute },
  { id: 'cleanup', label: 'Cleanup', icon: IconBrush },
  { id: 'swap', label: 'Swap', icon: IconLink },
  { id: 'clicker', label: 'Clicker', icon: IconCookie },
  { id: 'crumb', label: 'CRUMB', icon: IconCoins },
]

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (offerFromHash() ? 'swap' : 'snapshot'))
  const [snapshot, setSnapshot] = useState<SnapshotResult | null>(null)
  const [presetMint, setPresetMint] = useState<string | null>(null)
  const install = useInstallPrompt()
  const snapshotOf = (mint: string) => {
    setPresetMint(mint)
    setTab('snapshot')
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          Crumbs <span>for Cookie Chain</span>
        </div>
        <div className="row">
          {install && (
            <button className="btn" onClick={install} title="Install Crumbs as an app">
              <IconDownload /> Install
            </button>
          )}
          <WalletButton />
        </div>
      </header>

      <section className="hero with-art">
        <div>
          <h1>The utility app for Cookie Chain.</h1>
          <p>Snapshot holders, airdrop tokens, tidy your wallet, and play the clicker that mints CRUMB. Runs in your browser, installs as an app, takes no fee.</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}hero.svg`} alt="" width={480} height={270} loading="eager" />
        </div>
      </section>

      <StatStrip />

      <nav className="tabs" role="tablist" aria-label="Tools">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            <Icon /> {label}
          </button>
        ))}
      </nav>

      <div className="panel" key={tab}>
        {tab === 'snapshot' && <Snapshot result={snapshot} onResult={setSnapshot} onAirdrop={() => setTab('airdrop')} presetMint={presetMint} onPresetUsed={() => setPresetMint(null)} />}
        {tab === 'airdrop' && <Airdrop snapshot={snapshot} onNeedSnapshot={() => setTab('snapshot')} onSnapshot={setSnapshot} />}
        {tab === 'cleanup' && <Cleanup />}
        {tab === 'swap' && <Swap />}
        {tab === 'clicker' && <Clicker onSnapshot={snapshotOf} />}
        {tab === 'crumb' && <Crumb onSnapshot={snapshotOf} />}
      </div>

      <Roadmap />

      <footer>
        <span>Utilities for Cookie Chain communities. No fees, no backend, your wallet signs every transaction.</span>
        <a href="https://cookiescan.io" target="_blank" rel="noreferrer">Cookiescan</a>
        <a href="https://hyperlane.cookiescan.io" target="_blank" rel="noreferrer">Bridge COOK</a>
        <a href="https://nightly.app" target="_blank" rel="noreferrer">Nightly wallet</a>
      </footer>
      <Toaster />
    </div>
  )
}
