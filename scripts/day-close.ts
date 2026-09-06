// Settle and claim a finished UTC day for one player, signing as the owner. WALLET env = a JSON
// secret-key array or a {mnemonic, path} file; DRY=1 prints state without sending.
import { readFileSync } from 'node:fs'
import { createHmac, pbkdf2Sync } from 'node:crypto'
import { Connection, Keypair } from '@solana/web3.js'
import { RPC_URL } from '../src/lib/chain'
import { GameClient } from '../src/game/client'
import { CRUMB_DECIMALS, dayIndex } from '../src/game/constants'

/** BIP-39 seed + SLIP-0010 ed25519 derivation (all segments hardened), no extra packages. */
function fromMnemonic(mnemonic: string, path: string): Keypair {
  const seed = pbkdf2Sync(mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512')
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest()
  let key = I.subarray(0, 32), chain = I.subarray(32)
  for (const seg of path.replace(/^m\//, '').split('/')) {
    const idx = (parseInt(seg, 10) + 0x80000000) >>> 0
    const data = Buffer.concat([Buffer.from([0]), key, Buffer.from([idx >>> 24, (idx >>> 16) & 255, (idx >>> 8) & 255, idx & 255])])
    I = createHmac('sha512', chain).update(data).digest()
    key = I.subarray(0, 32); chain = I.subarray(32)
  }
  return Keypair.fromSeed(key)
}

const wallet = JSON.parse(readFileSync(process.env.WALLET!, 'utf8'))
const owner = Array.isArray(wallet) ? Keypair.fromSecretKey(Uint8Array.from(wallet)) : fromMnemonic(wallet.mnemonic, wallet.path ?? "m/44'/501'/0'/0'")
const conn = new Connection(RPC_URL, 'confirmed')
const client = new GameClient(conn)
const crumb = (n: bigint) => (Number(n) / 10 ** CRUMB_DECIMALS).toLocaleString('en-US', { maximumFractionDigits: 2 })
const cookies = (n: bigint) => (Number(n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })

const today = dayIndex(Date.now() / 1000)
const player = await client.fetchPlayer(owner.publicKey)
if (!player) throw new Error(`no player for ${owner.publicKey.toBase58()}`)
const [em0, bal0, cook] = await Promise.all([client.fetchEmission(), client.fetchCrumbBalance(owner.publicKey), conn.getBalance(owner.publicKey)])
console.log('owner', owner.publicKey.toBase58(), '| COOK', (cook / 1e9).toFixed(4))
console.log('today', today.toString(), '| pending day', player.pendingDay.toString(), '| pending clicks', player.pendingClicks.toString(), '| pending cookies', cookies(player.pendingCookiesMilli))
console.log('claimable', crumb(player.claimable), '| claimed', crumb(player.claimed), '| CRUMB balance', crumb(bal0), '| emission minted', crumb(em0.minted))
const day = await client.fetchDay(player.pendingDay)
if (day) console.log(`day ${day.day} record: ${cookies(day.cookiesMilli)} cookies, ${day.clicks} clicks, pool ${crumb(day.pool)} CRUMB`)
if (process.env.DRY) process.exit(0)
if (player.pendingDay === today && player.claimable === 0n) throw new Error('the pending day is still running; nothing to settle yet')

const sent = await client.sendWithSession(owner, [client.claimIx(owner.publicKey, owner.publicKey, player)])
await client.confirm(sent)
console.log('claim tx', sent.signature)
const [p2, em1, bal1] = await Promise.all([client.fetchPlayer(owner.publicKey), client.fetchEmission(), client.fetchCrumbBalance(owner.publicKey)])
console.log('after: claimable', crumb(p2!.claimable), '| claimed', crumb(p2!.claimed), '| CRUMB balance', crumb(bal1), `(+${crumb(bal1 - bal0)})`, '| emission minted', crumb(em1.minted), `(+${crumb(em1.minted - em0.minted)})`)
