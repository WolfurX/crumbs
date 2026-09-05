# Crumbs

Holder snapshots, airdrops and token account cleanup for [Cookie Chain](https://www.cookiechain.wtf). An installable web app that runs entirely in your browser: reads come from the public Cookie Chain RPC and the Cookiescan DAS index, writes are transactions your own wallet signs. No backend, no fees, no keys leave your device.

Live: https://wolfurx.github.io/crumbs/

## What it does

**Snapshot.** Type a token symbol or mint and get every holder from the Cookiescan DAS index, folded by owner (a wallet with several token accounts counts once). Program-owned accounts such as pools, vaults and escrows are flagged and hidden by default so a snapshot means people, not liquidity. You get holder count, concentration, a top-10 chart, a filterable table and a CSV export.

**Airdrop.** Send COOK or any SPL / Token-2022 token you hold to a snapshot or to a pasted list. Same amount for everyone, pro-rata to holdings, or an amount per line. Crumbs packs transfers into as few transactions as fit under the 1232-byte limit, creates missing recipient token accounts idempotently, asks the wallet to sign everything in one prompt, then sends and confirms transaction by transaction with live status, Cookiescan links, expiry-aware retries and a results CSV. Costs are shown before you sign: total sent, network fees, and the rent for new accounts (which the recipients can reclaim by closing them).

**Cleanup.** Every token account your wallet owns, across both token programs. Revoke delegates you do not recognise and close empty accounts to get their rent back. No cut is taken.

## Using it

1. Install [Nightly](https://nightly.app), the wallet with first-class Cookie Chain support, and add the Cookie Chain RPC `https://rpc.cookiescan.io` in its network settings so your balances show. Any wallet that speaks the Wallet Standard will connect; Crumbs sends transactions to the Cookie Chain RPC itself, so the wallet only has to sign.
2. Get a little COOK for fees. Bridge from Solana at https://hyperlane.cookiescan.io, or swap on a Cookie Chain DEX. A 100-recipient airdrop costs well under 0.01 COOK in fees plus about 0.002 COOK of rent per recipient who has no token account yet.
3. Open https://wolfurx.github.io/crumbs/ and install it from the browser menu if you want it as an app. The shell and the token registry are cached for offline use.

## How it works

- Holders come from `getTokenAccounts` on `api.cookiescan.io`, paged 1000 at a time, aggregated by owner. Owners that are not on the ed25519 curve are program addresses and are marked as such.
- Token metadata comes from the Cookiescan registry at `cookiescan.io/api/tokens`; unlisted mints fall back to on-chain decimals.
- Transactions are legacy `Transaction`s with a compute-unit limit sized to their contents. Packing is by measured serialized size, not by a fixed count. Each recipient's instructions stay together in one transaction.
- Signing uses `signAllTransactions` when the wallet offers it, otherwise one prompt per transaction. Confirmation waits on the blockhash's last valid block height; expired transactions are marked so they can be re-signed against a fresh blockhash without resending the ones that landed.
- Native COOK reuses Solana's native mint id (`So111…112`) and has 9 decimals.

## Development

```
npm install
npm run dev          # http://localhost:5173/crumbs/
npm run build        # dist/ with service worker and manifest
npm run preview
```

`scripts/engine-test.ts` runs the airdrop and cleanup code against the live chain with a local keypair (build it with `npx vite build --config vite.engine.config.ts`). `scripts/e2e-snapshot.mjs` drives the built app in a headless Chromium over the DevTools protocol.

Deployed from `main` by GitHub Actions to GitHub Pages.

## Credits

Built for the Cookie Chain community. Reads run on the Cookiescan DAS API and RPC. The tool shapes owe a debt to Famous Fox Federation's Snapshot, FoxyShare, FoxySend and Revoker on Solana.

MIT licensed.
