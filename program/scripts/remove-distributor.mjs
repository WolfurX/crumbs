// Close a disabled distributor record. Usage: node scripts/remove-distributor.mjs <signer pubkey>
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { loadIdl, ix, meta } from './anchor-lite.mjs'
const conn = new Connection('https://rpc.cookiescan.io', 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const idl = loadIdl(new URL('../target/idl/crumb_emission.json', import.meta.url).pathname)
const EMISSION = new PublicKey(idl.address)
const signer = new PublicKey(process.argv[2])
const [emissionPda] = PublicKey.findProgramAddressSync([Buffer.from('emission')], EMISSION)
const [distributorPda] = PublicKey.findProgramAddressSync([Buffer.from('distributor'), signer.toBuffer()], EMISSION)
const tx = new Transaction().add(ix(EMISSION, idl, 'remove_distributor', [], [meta(admin.publicKey, true, true), meta(emissionPda, true), meta(distributorPda, true)]))
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
tx.recentBlockhash = blockhash; tx.feePayer = admin.publicKey; tx.sign(admin)
const sig = await conn.sendRawTransaction(tx.serialize())
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
console.log('removed distributor', distributorPda.toBase58(), sig.slice(0, 12) + '…', '| still exists:', !!(await conn.getAccountInfo(distributorPda)))
