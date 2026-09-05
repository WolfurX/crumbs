// Disable a distributor (weight 0) so a replacement can take its weight. Usage: node scripts/retire-distributor.mjs <signer pubkey> <name>
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { loadIdl, ix, meta, u16, bool, str } from './anchor-lite.mjs'
const conn = new Connection('https://rpc.cookiescan.io', 'confirmed')
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const idl = loadIdl(new URL('../target/idl/crumb_emission.json', import.meta.url).pathname)
const EMISSION = new PublicKey(idl.address)
const signer = new PublicKey(process.argv[2])
const [emissionPda] = PublicKey.findProgramAddressSync([Buffer.from('emission')], EMISSION)
const [distributorPda] = PublicKey.findProgramAddressSync([Buffer.from('distributor'), signer.toBuffer()], EMISSION)
const tx = new Transaction().add(ix(EMISSION, idl, 'set_distributor', [u16(0), bool(false), str(process.argv[3] ?? 'retired')], [
  meta(admin.publicKey, true, true), meta(emissionPda, true), meta(signer), meta(distributorPda, true), meta(SystemProgram.programId),
]))
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
tx.recentBlockhash = blockhash; tx.feePayer = admin.publicKey; tx.sign(admin)
const sig = await conn.sendRawTransaction(tx.serialize())
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
console.log('retired', signer.toBase58(), sig)
