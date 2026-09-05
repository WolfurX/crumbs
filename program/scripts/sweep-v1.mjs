// Close every account still owned by the retired clicker v1 id through the sweeper, then report.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { loadIdl, ix, meta } from './anchor-lite.mjs'
const conn = new Connection('https://rpc.cookiescan.io', 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const idl = loadIdl(new URL('../target/idl/sweeper.json', import.meta.url).pathname)
const OLD = new PublicKey(idl.address)
const accounts = await conn.getProgramAccounts(OLD)
console.log(`${accounts.length} accounts owned by ${OLD.toBase58()}`)
let recovered = 0
for (const a of accounts) {
  const tx = new Transaction().add(ix(OLD, idl, 'close', [], [meta(admin.publicKey, false, true), meta(a.pubkey, true), meta(admin.publicKey, true)]))
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  tx.recentBlockhash = blockhash; tx.feePayer = admin.publicKey; tx.sign(admin)
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
  recovered += a.account.lamports
  console.log('closed', a.pubkey.toBase58(), (a.account.lamports / 1e9).toFixed(6), 'COOK', sig.slice(0, 12) + '…')
}
console.log('recovered', (recovered / 1e9).toFixed(6), 'COOK; remaining accounts:', (await conn.getProgramAccounts(OLD)).length)
