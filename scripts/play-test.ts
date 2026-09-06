// Start a player for a keypair wallet and click a few times, so a finished day can be settled and
// claimed from a script. WALLET env = JSON secret-key array, CLICKS env = number of clicks (default 5).
import { readFileSync } from 'node:fs'
import { ComputeBudgetProgram, Connection, Keypair } from '@solana/web3.js'
import { RPC_URL } from '../src/lib/chain'
import { GameClient } from '../src/game/client'

const conn = new Connection(RPC_URL, 'confirmed')
const client = new GameClient(conn)
const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET!, 'utf8'))))
const clicks = Number(process.env.CLICKS ?? 5)

let player = await client.fetchPlayer(me.publicKey)
if (!player) {
  const game = await client.fetchGame()
  const burn = game.players >= game.freeSlots ? 1n : 0n // only decides whether the CRUMB account is passed
  const s = await client.sendWithSession(me, [client.startIx(me.publicKey, me.publicKey, game, burn)])
  await client.confirm(s)
  console.log('started player', me.publicKey.toBase58().slice(0, 8), s.signature)
  player = (await client.fetchPlayer(me.publicKey))!
}
for (let i = 0; i < clicks; i++) {
  const s = await client.sendWithSession(me, [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 + i }), client.clickIx(me.publicKey, me.publicKey, player)])
  await client.confirm(s)
  console.log(`click ${i + 1}/${clicks}`, s.signature.slice(0, 16))
  await new Promise((r) => setTimeout(r, 500))
}
player = (await client.fetchPlayer(me.publicKey))!
console.log('pending day', player.pendingDay.toString(), '| pending clicks', player.pendingClicks.toString(), '| pending cookies (milli)', player.pendingCookiesMilli.toString(), '| cps (milli)', player.cpsMilli.toString())
