// Live engine test: runs the same planAirdrop/runBatches/cleanup code the UI calls, signing with the
// throwaway test keypair instead of a wallet. Spends a few hundredths of a COOK.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token'
import { RPC_URL, COOK_MINT } from '../src/lib/chain'
import { planAirdrop, resolveAsset } from '../src/lib/airdrop'
import { runBatches, type Batch, type Signer } from '../src/lib/txs'
import { closeItem, fetchOwnedAccounts, packCleanup, revokeItem } from '../src/lib/revoke'
import { fmtAmount } from '../src/lib/format'

const conn = new Connection(RPC_URL, 'confirmed')
const wallet = JSON.parse(readFileSync(`${process.env.HOME}/.config/crumbs/test-wallet.json`, 'utf8'))
const kp = Keypair.fromSecretKey(Uint8Array.from(wallet.secretKey))
const signer: Signer = {
  publicKey: kp.publicKey,
  signTransaction: async <T extends Transaction>(tx: T) => (tx.sign(kp), tx),
  signAllTransactions: async <T extends Transaction>(txs: T[]) => (txs.forEach((t) => t.sign(kp)), txs),
}
const log = (b: Batch) => console.log(`  batch ${b.id}: ${b.status}${b.signature ? ' ' + b.signature.slice(0, 12) + '…' : ''}${b.error ? ' ' + b.error : ''}`)
const bal = async () => fmtAmount(BigInt(await conn.getBalance(kp.publicKey)), 9)

console.log('wallet', kp.publicKey.toBase58(), 'balance', await bal(), 'COOK')
const recipients = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58())

// 1. native COOK airdrop
console.log('\n1. native airdrop, 0.001 COOK x3')
const native = await planAirdrop(conn, kp.publicKey, await resolveAsset(conn, COOK_MINT), recipients.map((owner) => ({ owner, amount: 1_000_000n })))
console.log(`  plan: ${native.recipients.length} recipients, ${native.batches.length} tx, fee ${fmtAmount(native.feeLamports, 9)}`)
await runBatches({ connection: conn, signer, batches: native.batches, onUpdate: log })
for (const r of recipients) console.log('  recipient balance', r.slice(0, 6), await conn.getBalance(new PublicKey(r)))

// 2. create a test token and mint 1000 to self
console.log('\n2. create test mint')
const mint = Keypair.generate()
const rent = await getMinimumBalanceForRentExemptMint(conn)
const ata = getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey)
const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: kp.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(mint.publicKey, 6, kp.publicKey, null),
  createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, mint.publicKey),
  createMintToInstruction(mint.publicKey, ata, kp.publicKey, 1_000_000_000n),
  // a delegate to revoke later
  createApproveInstruction(ata, Keypair.generate().publicKey, kp.publicKey, 5_000_000n),
)
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
tx.recentBlockhash = blockhash
tx.feePayer = kp.publicKey
tx.sign(kp, mint)
const sig = await conn.sendRawTransaction(tx.serialize())
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight })
console.log('  mint', mint.publicKey.toBase58(), 'tx', sig.slice(0, 12) + '…')

// 3. token airdrop with ATA creation, 3 recipients + 2 more so it packs
console.log('\n3. token airdrop, 100 TEST each to 5 wallets (all need ATAs)')
const more = [...recipients, Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()]
const asset = await resolveAsset(conn, mint.publicKey.toBase58(), 'TEST')
const plan = await planAirdrop(conn, kp.publicKey, asset, more.map((owner) => ({ owner, amount: 100_000_000n })))
console.log(`  plan: ${plan.recipients.length} recipients, ${plan.batches.length} tx, ${plan.ataCreates} ATA creates, rent ${fmtAmount(plan.rentLamports, 9)} COOK, units ${plan.batches.map((b) => b.computeUnits).join('/')}`)
await runBatches({ connection: conn, signer, batches: plan.batches, onUpdate: log })
const again = await planAirdrop(conn, kp.publicKey, asset, more.map((owner) => ({ owner, amount: 1n })))
console.log(`  re-plan sees ${again.ataCreates} ATA creates (expect 0)`)

// 4. cleanup: revoke the delegate, then empty the ATA and close it
console.log('\n4. cleanup')
let owned = await fetchOwnedAccounts(conn, kp.publicKey)
const mine = owned.find((a) => a.mint === mint.publicKey.toBase58())!
console.log(`  own ATA: amount ${mine.amount} delegate ${mine.delegate?.slice(0, 6)} allowance ${mine.delegatedAmount}`)
const revoke = packCleanup(kp.publicKey, [revokeItem(mine, kp.publicKey)])
await runBatches({ connection: conn, signer, batches: revoke, onUpdate: log })
// send the remaining 500 TEST away so the account is empty, then close it
const drain = await planAirdrop(conn, kp.publicKey, asset, [{ owner: recipients[0], amount: 500_000_000n }])
await runBatches({ connection: conn, signer, batches: drain.batches, onUpdate: log })
owned = await fetchOwnedAccounts(conn, kp.publicKey)
const empty = owned.find((a) => a.mint === mint.publicKey.toBase58())!
console.log(`  after drain: amount ${empty.amount} delegate ${empty.delegate ?? 'none'} rent ${fmtAmount(empty.rent, 9)}`)
const close = packCleanup(kp.publicKey, [closeItem(empty, kp.publicKey)])
await runBatches({ connection: conn, signer, batches: close, onUpdate: log })
owned = await fetchOwnedAccounts(conn, kp.publicKey)
console.log(`  accounts left for this mint: ${owned.filter((a) => a.mint === mint.publicKey.toBase58()).length} (expect 0)`)
console.log('\nfinal balance', await bal(), 'COOK')
