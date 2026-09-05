// Live test of swap-by-link with two local keypairs: maker = the deployer test wallet, taker = a fresh
// keypair funded from it. Creates the nonce, builds + partially signs the offer, encodes, decodes,
// checks it is open, signs as taker, sends, then confirms balances moved atomically.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token'
import { RPC_URL, COOK_MINT } from '../src/lib/chain'
import { buildOfferTx, createNonceIxs, decodeOffer, encodeOffer, offerIsOpen, readNonce, resolveLeg, cancelIx } from '../src/swap/offer'

const conn = new Connection(RPC_URL, 'confirmed')
const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const taker = Keypair.generate()
const TEST_MINT = '3zdx7SusN4kBy1pLXSckw26k6v6xwvbXS7ze3AHnkQef' // the 6-decimal test token the maker still holds

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

console.log('maker', maker.publicKey.toBase58(), '| taker', taker.publicKey.toBase58())
// fund the taker with 0.05 COOK for fees, rent and its leg
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: maker.publicKey, toPubkey: taker.publicKey, lamports: 50_000_000 })), [maker])

// the maker's TEST account was closed in an earlier test: mint 10 TEST back (maker is the mint authority)
const makerAta = getAssociatedTokenAddressSync(new PublicKey(TEST_MINT), maker.publicKey)
await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, makerAta, maker.publicKey, new PublicKey(TEST_MINT)), createMintToInstruction(new PublicKey(TEST_MINT), makerAta, maker.publicKey, 10_000_000n)), [maker])

// 1. maker's nonce account
const nonceKp = Keypair.generate()
await send(new Transaction().add(...(await createNonceIxs(conn, maker.publicKey, nonceKp))), [maker, nonceKp])
const n = await readNonce(conn, nonceKp.publicKey)
console.log('nonce created', nonceKp.publicKey.toBase58().slice(0, 8), 'value', n!.nonce.slice(0, 8))

// 2. offer: maker gives 3 TEST, gets 0.01 COOK
const give = await resolveLeg(conn, TEST_MINT, '3')
const get = await resolveLeg(conn, COOK_MINT, '0.01')
const tx = buildOfferTx(maker.publicKey, taker.publicKey, give, get, nonceKp.publicKey, n!.nonce)
tx.partialSign(maker)
const encoded = encodeOffer(tx)
console.log('offer link payload', encoded.length, 'chars')

// 3. taker side: decode, verify, check open
const offer = decodeOffer(encoded)
console.log('decoded: give', offer.give.amount.toString(), offer.give.mint.slice(0, 6), '| get', offer.get.amount.toString(), 'COOK lamports | open:', await offerIsOpen(conn, offer))
// tamper check: a modified payload must fail
try { decodeOffer(encoded.slice(0, -4) + 'BBBB'); console.log('TAMPER NOT DETECTED') } catch (e) { console.log('tampered link rejected:', (e as Error).message) }

// 4. taker signs and sends
const takerAta = getAssociatedTokenAddressSync(new PublicKey(TEST_MINT), taker.publicKey)
const makerCookBefore = await conn.getBalance(maker.publicKey)
offer.tx.partialSign(taker)
const sig = await conn.sendRawTransaction(offer.tx.serialize())
const r = await conn.confirmTransaction({ signature: sig, blockhash: offer.nonce, lastValidBlockHeight: (await conn.getBlockHeight()) + 150 })
if (r.value.err) throw new Error('swap failed ' + JSON.stringify(r.value.err))
console.log('swap tx', sig)
const takerTest = (await getAccount(conn, takerAta)).amount
const makerCookAfter = await conn.getBalance(maker.publicKey)
console.log('taker TEST balance', takerTest.toString(), '(expect 3000000) | maker COOK delta', (makerCookAfter - makerCookBefore) / 1e9, '(expect +0.01)')
console.log('offer still open after fill:', await offerIsOpen(conn, offer), '(expect false: nonce advanced)')

// 5. a second offer, then cancel it; the link must read as closed
const n2 = await readNonce(conn, nonceKp.publicKey)
const tx2 = buildOfferTx(maker.publicKey, taker.publicKey, give, get, nonceKp.publicKey, n2!.nonce)
tx2.partialSign(maker)
const offer2 = decodeOffer(encodeOffer(tx2))
console.log('offer2 open:', await offerIsOpen(conn, offer2))
await send(new Transaction().add(cancelIx(maker.publicKey, nonceKp.publicKey)), [maker])
console.log('offer2 open after cancel:', await offerIsOpen(conn, offer2), '(expect false)')
