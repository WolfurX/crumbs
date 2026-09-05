// Take an offer link as the deployer test wallet: decode, verify, dry-run, sign, send. LINK env var.
import { readFileSync } from 'node:fs'
import { Connection, Keypair } from '@solana/web3.js'
import { RPC_URL } from '../src/lib/chain'
import { decodeOffer, offerFromHash, offerIsOpen, simulateOffer } from '../src/swap/offer'

const conn = new Connection(RPC_URL, 'confirmed')
const taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/deployer.json`, 'utf8'))))
const encoded = offerFromHash(new URL(process.env.LINK!).hash)!
const offer = decodeOffer(encoded)
console.log('maker', offer.maker.toBase58().slice(0, 8), '| taker', offer.taker.toBase58().slice(0, 8), '| me', taker.publicKey.toBase58().slice(0, 8))
console.log('give', offer.give.amount.toString(), offer.give.mint.slice(0, 8), '| get', offer.get.amount.toString(), offer.get.mint.slice(0, 8))
console.log('open:', await offerIsOpen(conn, offer), '| dry run:', JSON.stringify(await simulateOffer(conn, offer)))
if (!offer.taker.equals(taker.publicKey)) throw new Error('not addressed to me')
offer.tx.partialSign(taker)
const sig = await conn.sendRawTransaction(offer.tx.serialize())
const r = await conn.confirmTransaction({ signature: sig, blockhash: offer.nonce, lastValidBlockHeight: (await conn.getBlockHeight()) + 150 })
console.log('filled:', r.value.err ? JSON.stringify(r.value.err) : 'ok', sig)
console.log('open after fill:', await offerIsOpen(conn, offer))
