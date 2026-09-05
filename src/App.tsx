import { useState } from 'react'
import { WalletButton } from './components/WalletButton'
import { Snapshot, type SnapshotResult } from './components/Snapshot'
import { Airdrop } from './components/Airdrop'
import { Cleanup } from './components/Cleanup'
import { IconAperture, IconBrush, IconParachute } from './icons'

type Tab = 'snapshot' | 'airdrop' | 'cleanup'

const TABS: { id: Tab; label: string; icon: typeof IconAperture }[] = [
  { id: 'snapshot', label: 'Snapshot', icon: IconAperture },
  { id: 'airdrop', label: 'Airdrop', icon: IconParachute },
  { id: 'cleanup', label: 'Cleanup', icon: IconBrush },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('snapshot')
  const [snapshot, setSnapshot] = useState<SnapshotResult | null>(null)

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          Crumbs <span>for Cookie Chain</span>
        </div>
        <WalletButton />
      </header>

      <section className="hero">
        <h1>The utility app for Cookie Chain.</h1>
        <p>Snapshot holders, airdrop tokens, tidy your wallet. Runs in your browser, installs as an app, takes no fee.</p>
      </section>

      <nav className="tabs" role="tablist" aria-label="Tools">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            <Icon /> {label}
          </button>
        ))}
      </nav>

      <div className="panel" key={tab}>
        {tab === 'snapshot' && <Snapshot result={snapshot} onResult={setSnapshot} onAirdrop={() => setTab('airdrop')} />}
        {tab === 'airdrop' && <Airdrop snapshot={snapshot} onNeedSnapshot={() => setTab('snapshot')} />}
        {tab === 'cleanup' && <Cleanup />}
      </div>

      <footer>
        <span>Open source, no fees, nothing leaves your browser except signed transactions.</span>
        <a href="https://github.com/WolfurX/crumbs" target="_blank" rel="noreferrer">Source</a>
        <a href="https://cookiescan.io" target="_blank" rel="noreferrer">Cookiescan</a>
        <a href="https://hyperlane.cookiescan.io" target="_blank" rel="noreferrer">Bridge COOK</a>
        <a href="https://nightly.app" target="_blank" rel="noreferrer">Nightly wallet</a>
      </footer>
    </div>
  )
}
