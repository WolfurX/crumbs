// Live .cook name test: resolves real names on mainnet through src/lib/names and checks them against
// values decoded independently (scratch probe, 2026-09-10). Read-only, costs nothing.
import { Connection } from '@solana/web3.js'
import { RPC_URL } from '../src/lib/chain'
import { isLabel, looksLikeName, primaryNames, resolveName, resolveNames, toLabel } from '../src/lib/names'

const MEME = 'AuCPPPDywCr9tq3LrYC4cGM5mpfYpZy1ZKYhshZvPtFj' // owns meme.cook, primary meme.cook
const BOOK = 'AmZDfCaqwzqnCiiu3Go91BJGctrKsUBQS4ydR3SAao7i' // owns book.cook, primary domains.cook
const TEST = 'GUiLxP1nZ93gXPENU3nMjhXQCt32QLfguW3sH8L6XHZK' // no name
const c = new Connection(RPC_URL)
let fails = 0
const check = (what: string, ok: boolean, got?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` -> ${String(got)}`}`)
  if (!ok) fails++
}
check('toLabel strips suffix and case', toLabel(' Meme.COOK ') === 'meme', toLabel(' Meme.COOK '))
check('isLabel rejects uppercase', !isLabel('Meme'))
check('isLabel rejects edge hyphens', !isLabel('-a') && !isLabel('a-'))
check('looksLikeName: a public key is not a name', !looksLikeName(MEME))
check('looksLikeName: bare label', looksLikeName('meme'))
check('looksLikeName: explicit suffix', looksLikeName('Meme.cook'))
const meme = await resolveName(c, 'Meme.cook')
check('meme.cook resolves to its owner', meme?.toBase58() === MEME, meme?.toBase58())
const many = await resolveNames(c, ['book', 'no-such-name-xyz-123', 'BAD name'])
check('book resolves to its owner', many.get('book')?.toBase58() === BOOK, many.get('book')?.toBase58())
check('unregistered name is null', many.get('no-such-name-xyz-123') === null, many.get('no-such-name-xyz-123'))
check('invalid label is null', many.get('BAD name') === null, many.get('BAD name'))
const rev = await primaryNames(c, [MEME, TEST, BOOK])
check('reverse: meme owner shows meme.cook', rev.get(MEME) === 'meme.cook', rev.get(MEME))
check('reverse: wallet without a name is absent', !rev.has(TEST), rev.get(TEST))
check('reverse: primary differs from owned name', rev.get(BOOK) === 'domains.cook', rev.get(BOOK))
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
