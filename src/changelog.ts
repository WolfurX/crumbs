/** What changed, newest first. One entry per release that reached production. */
export const CHANGELOG: { date: string; title: string; text: string }[] = [
  {
    date: '2026-09-23',
    title: 'NFT holder snapshots and a bakery',
    text: 'Snapshot takes an NFT collection too: every wallet holding its pieces with the count each holds, read from the chain, ready for a holder-only airdrop. A finished Mint NFT drop links straight to it. On the Clicker, every baker you own stands beside the cookie and sends crumbs its way; the ones still to buy wait as outlines.',
  },
  {
    date: '2026-09-16',
    title: 'Quality of life',
    text: 'Tabs keep what you were doing and live in the URL, so reload, back and links land where you were. The last snapshot survives a reload. Airdrop gets an exclude list and a history of what you sent; Snapshot gets copy addresses and retake. A signed swap offer stays on the Swap tab with its status until it is taken or cancelled.',
  },
  {
    date: '2026-09-13',
    title: 'Mint NFT',
    text: 'Quick drops: one picture, numbered copies, to your wallet, to a token’s holders or to a list. The picture is stored on Cookie Chain itself and one wallet approval mints everything.',
  },
  {
    date: '2026-09-10',
    title: '.cook names and a 3D cookie',
    text: 'Names resolve wherever Crumbs asks for a wallet and show on the leaderboard and in holder tables. The clicker cookie and the hero drawing became three.js scenes.',
  },
  {
    date: '2026-09-06',
    title: 'Swap by link',
    text: 'Peer-to-peer swaps in one transaction: sign your side, send the link, the other wallet signs theirs. The clicker got floating gains, a click sound, an away summary and a bakery share card.',
  },
  {
    date: '2026-09-05',
    title: 'Launch',
    text: 'Holder snapshots, airdrops, token account cleanup, and Crumb Clicker, the game that mints CRUMB.',
  },
]
