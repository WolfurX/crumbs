// Makes (or cancels) a real swap offer from the deployer test wallet so the browser test can seed
// `crumbs.offer.<maker>` and watch the Swap tab restore it. Reuses the wallet's nonce account when
// it has one. Usage: node scripts/swap-offer-seed.ts make  -> prints JSON {maker, nonce, encoded}
//                    node scripts/swap-offer-seed.ts cancel <nonce>
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { RPC_URL, COOK_MINT } from '../src/lib/chain'
import { buildOfferTx, cancelIx, createNonceIxs, encodeOffer, readNonce, resolveLeg } from '../src/swap/offer'

const conn = new Connection(RPC_URL, 'confirmed')
const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))

async function send(tx: Transaction, signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
  if (r.value.err) throw new Error(JSON.stringify(r.value.err))
  return sig
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'cancel') {
  const sig = await send(new Transaction().add(cancelIx(maker.publicKey, new PublicKey(arg))), [maker])
  console.error('cancelled', sig)
} else {
  const owned = await conn.getProgramAccounts(SystemProgram.programId, { filters: [{ dataSize: 80 }, { memcmp: { offset: 8, bytes: maker.publicKey.toBase58() } }] })
  let nonce = owned[0]?.pubkey
  if (!nonce) {
    const kp = Keypair.generate()
    await send(new Transaction().add(...(await createNonceIxs(conn, maker.publicKey, kp))), [maker, kp])
    nonce = kp.publicKey
    console.error('nonce created', nonce.toBase58())
  }
  const n = await readNonce(conn, nonce)
  if (!n) throw new Error('nonce unreadable')
  const taker = Keypair.generate().publicKey // nobody can take it
  const give = await resolveLeg(conn, COOK_MINT, '0.001')
  const get = await resolveLeg(conn, COOK_MINT, '0.002')
  const tx = buildOfferTx(maker.publicKey, taker, give, get, nonce, n.nonce)
  tx.partialSign(maker)
  console.log(JSON.stringify({ maker: maker.publicKey.toBase58(), makerBytes: Array.from(maker.publicKey.toBytes()), nonce: nonce.toBase58(), encoded: encodeOffer(tx) }))
}
process.exit(0)
