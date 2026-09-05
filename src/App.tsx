import { useState } from 'react'
import { WalletButton } from './components/WalletButton'
import { Snapshot, type SnapshotResult } from './components/Snapshot'
import { Airdrop } from './components/Airdrop'
import { Cleanup } from './components/Cleanup'

type Tab = 'snapshot' | 'airdrop' | 'cleanup'

export default function App() {
  const [tab, setTab] = useState<Tab>('snapshot')
  const [snapshot, setSnapshot] = useState<SnapshotResult | null>(null)

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
          Crumbs <span>on Cookie Chain</span>
        </div>
        <WalletButton />
      </header>

      <nav className="tabs" role="tablist" aria-label="Tools">
        {(
          [
            ['snapshot', 'Snapshot'],
            ['airdrop', 'Airdrop'],
            ['cleanup', 'Cleanup'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'snapshot' && (
        <Snapshot
          result={snapshot}
          onResult={setSnapshot}
          onAirdrop={() => setTab('airdrop')}
        />
      )}
      {tab === 'airdrop' && <Airdrop snapshot={snapshot} onNeedSnapshot={() => setTab('snapshot')} />}
      {tab === 'cleanup' && <Cleanup />}

      <footer>
        <span>Open source, no fees, nothing leaves your browser except signed transactions.</span>
        <a href="https://github.com/WolfurX/crumbs" target="_blank" rel="noreferrer">Source</a>
        <a href="https://cookiescan.io" target="_blank" rel="noreferrer">Cookiescan</a>
        <a href="https://hyperlane.cookiescan.io" target="_blank" rel="noreferrer">Bridge COOK</a>
      </footer>
    </div>
  )
}
