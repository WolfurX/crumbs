import { IconHash, IconLink, IconUsers } from '../icons'

const ITEMS = [
  {
    icon: IconHash,
    name: '.cook names everywhere',
    text: 'Type a .cook name wherever Crumbs asks for an address: recipients, swap counterparties, the leaderboard.',
    status: 'in progress',
  },
  {
    icon: IconUsers,
    name: 'NFT collection snapshots',
    text: 'Every holder of a collection, with counts per wallet, ready for a holder-only airdrop.',
    status: 'planned',
  },
  {
    icon: IconLink,
    name: 'Open swap offers',
    text: 'Offers anyone can take, not just one named wallet. Needs a small escrow program; the targeted version ships first.',
    status: 'planned',
  },
]

const THREAD = 'https://x.com/0xWolfur/status/2096138792583520283'

/** What comes next. Kept honest: only things that are being built or firmly planned. */
export function Roadmap() {
  return (
    <section className="roadmap" aria-labelledby="roadmap-title">
      <div className="row between">
        <h2 id="roadmap-title">More utilities on the way</h2>
        <a className="small" href={THREAD} target="_blank" rel="noreferrer">Tell us what you need</a>
      </div>
      <ul className="roadmap-list">
        {ITEMS.map(({ icon: Icon, name, text, status }) => (
          <li key={name}>
            <Icon />
            <div>
              <div className="row" style={{ gap: '0.5rem' }}>
                <b>{name}</b>
                <span className="pill">{status}</span>
              </div>
              <p className="ink2 small">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
