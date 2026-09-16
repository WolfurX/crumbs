import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react'
import { WalletButton } from './components/WalletButton'
import { Snapshot, type SnapshotResult } from './components/Snapshot'
import { Airdrop } from './components/Airdrop'
import { Cleanup } from './components/Cleanup'
import { StatStrip } from './components/StatStrip'
import { Toaster } from './components/Toast'
import { Roadmap } from './components/Roadmap'
import { Changelog } from './components/Changelog'
import { Clicker } from './components/Clicker'
import { Crumb } from './components/Crumb'
import { Mint } from './components/Mint'
import { Swap } from './components/Swap'
import { useInstallPrompt } from './lib/install'
import { webglOk } from './lib/webgl'
import { loadSnapshot, saveSnapshot } from './lib/history'
import { TabActiveContext, setHashTab, tabFromHash, type Tab } from './lib/tabs'
import { IconAperture, IconBrush, IconCoins, IconCookie, IconDownload, IconLink, IconParachute, IconPhoto } from './icons'

const HeroScene = lazy(() => import('./components/HeroScene'))
const WIDE = '(min-width: 900px)'

const TABS: { id: Tab; label: string; icon: typeof IconAperture }[] = [
  { id: 'snapshot', label: 'Snapshot', icon: IconAperture },
  { id: 'airdrop', label: 'Airdrop', icon: IconParachute },
  { id: 'cleanup', label: 'Cleanup', icon: IconBrush },
  { id: 'swap', label: 'Swap', icon: IconLink },
  { id: 'clicker', label: 'Clicker', icon: IconCookie },
  { id: 'crumb', label: 'CRUMB', icon: IconCoins },
  { id: 'mint', label: 'Mint NFT', icon: IconPhoto },
]

export default function App() {
  // The tab lives in the URL hash. Tabs mount on first visit and stay mounted, hidden, so a
  // pasted list, a running airdrop or a signed swap link survives a look at another tab.
  const [tab, setTabState] = useState<Tab>(() => tabFromHash() ?? 'snapshot')
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]))
  const [snapshot, setSnapshotState] = useState<SnapshotResult | null>(() => loadSnapshot())
  const [presetMint, setPresetMint] = useState<string | null>(null)
  const install = useInstallPrompt()
  // the hero art only shows from 900px, so the 3D chunk is fetched only where it will be seen
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches)
  useEffect(() => {
    const mq = matchMedia(WIDE)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const show = useCallback((t: Tab) => {
    setTabState(t)
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)))
  }, [])
  useEffect(() => {
    const on = () => {
      const t = tabFromHash()
      if (t) show(t)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [show])
  const setTab = useCallback(
    (t: Tab) => {
      show(t)
      setHashTab(t)
    },
    [show],
  )
  const setSnapshot = useCallback((r: SnapshotResult) => {
    setSnapshotState(r)
    saveSnapshot(r)
  }, [])

  const heroImg = <img src={`${import.meta.env.BASE_URL}hero.svg`} alt="" width={480} height={270} loading="eager" />
  const snapshotOf = (mint: string) => {
    setPresetMint(mint)
    setTab('snapshot')
  }
  const panel = (id: Tab, node: ReactNode) =>
    visited.has(id) && (
      <div className="panel" key={id} hidden={tab !== id} role="tabpanel">
        <TabActiveContext.Provider value={tab === id}>{node}</TabActiveContext.Provider>
      </div>
    )

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
          <p>Snapshot holders, airdrop tokens, mint NFT drops stored on chain, tidy your wallet, and play the clicker that mints CRUMB. Runs in your browser, installs as an app, takes no fee.</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          {wide && webglOk() ? <Suspense fallback={heroImg}><HeroScene /></Suspense> : heroImg}
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

      {panel('snapshot', <Snapshot result={snapshot} onResult={setSnapshot} onAirdrop={() => setTab('airdrop')} presetMint={presetMint} onPresetUsed={() => setPresetMint(null)} />)}
      {panel('airdrop', <Airdrop snapshot={snapshot} onNeedSnapshot={() => setTab('snapshot')} onSnapshot={setSnapshot} />)}
      {panel('cleanup', <Cleanup />)}
      {panel('swap', <Swap />)}
      {panel('clicker', <Clicker onSnapshot={snapshotOf} />)}
      {panel('crumb', <Crumb onSnapshot={snapshotOf} />)}
      {panel('mint', <Mint snapshot={snapshot} onNeedSnapshot={() => setTab('snapshot')} />)}

      <Roadmap />
      <Changelog />

      <footer>
        <span>Utilities for Cookie Chain communities. No fees, no accounts, no servers holding your data. Your wallet signs every transaction.</span>
        <a href="https://cookiescan.io" target="_blank" rel="noreferrer">Cookiescan</a>
        <a href="https://hyperlane.cookiescan.io" target="_blank" rel="noreferrer">Bridge COOK</a>
        <a href="https://nightly.app" target="_blank" rel="noreferrer">Nightly wallet</a>
      </footer>
      <Toaster />
    </div>
  )
}
