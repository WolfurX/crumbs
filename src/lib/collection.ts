import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { TOKEN_PROGRAM } from './chain'
import type { Holder } from './das'
import { METADATA_PROGRAM, metadataPda } from '../mint/tm'

export interface NftMeta {
  name: string
  symbol: string
  creators: { address: string; verified: boolean; share: number }[]
  /** Token Metadata's standard: 0 NonFungible, 1 FungibleAsset, 2 Fungible, 3 NonFungibleEdition, 4 ProgrammableNonFungible; null on old accounts. */
  tokenStandard: number | null
  /** The collection this NFT is a piece of, when it points at one. */
  collection: { key: string; verified: boolean } | null
}

/** A Token Metadata account, read field by field. */
function decodeNftMeta(d: Uint8Array): NftMeta {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength)
  let o = 65 // key, update authority, mint
  const str = () => {
    const n = view.getUint32(o, true)
    const s = new TextDecoder().decode(d.subarray(o + 4, o + 4 + n)).replace(/\0+$/, '').trim()
    o += 4 + n
    return s
  }
  const name = str()
  const symbol = str()
  str() // uri
  o += 2 // royalty
  const creators: NftMeta['creators'] = []
  if (d[o++] === 1) {
    const n = view.getUint32(o, true)
    o += 4
    for (let i = 0; i < n; i++, o += 34) creators.push({ address: new PublicKey(d.subarray(o, o + 32)).toBase58(), verified: d[o + 32] === 1, share: d[o + 33] })
  }
  o += 2 // primary sale, mutable
  if (d[o++] === 1) o += 1 // edition nonce
  const tokenStandard = d[o++] === 1 ? d[o++] : null
  const collection = d[o] === 1 ? { verified: d[o + 1] === 1, key: new PublicKey(d.subarray(o + 2, o + 34)).toBase58() } : null
  return { name, symbol, creators, tokenStandard, collection }
}

/** Metadata for many mints in one go (hundreds per RPC call); null where a mint has none. */
export async function readNftMetas(connection: Connection, mints: PublicKey[]): Promise<(NftMeta | null)[]> {
  const out: (NftMeta | null)[] = new Array(mints.length).fill(null)
  for (let i = 0; i < mints.length; i += 100) {
    const slice = mints.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(slice.map(metadataPda))
    infos.forEach((info, j) => {
      if (info && info.owner.equals(METADATA_PROGRAM)) out[i + j] = decodeNftMeta(info.data)
    })
  }
  return out
}

/** Name, symbol and collection pointer from a mint's Token Metadata account; null when it has none. */
export async function readNftMeta(connection: Connection, mint: PublicKey): Promise<NftMeta | null> {
  return (await readNftMetas(connection, [mint]))[0]
}

// Token Metadata pads name, symbol and uri to 32, 10 and 200 bytes, so a piece's collection pointer
// sits at a fixed offset per creator count: 328 without creators, 332 + 34 per creator with them
// (edition nonce and token standard both set, as on every NFT a current Token Metadata mints).
// The pointer is a Some tag and the verified flag, then the collection mint.
const COLLECTION_AT = [328, 366, 400, 434, 468, 502]
const SOME_VERIFIED = bs58.encode(Uint8Array.from([1, 1]))
const AMOUNT_ONE = bs58.encode(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]))

/**
 * Every holder of a verified NFT collection, aggregated by owner with the pieces each holds, largest
 * first. Reads the chain, not an index: the pieces come from Token Metadata, their owners from one scan
 * of the token accounts holding exactly one token. Null when no piece points at `collection`.
 */
export async function fetchCollectionHolders(
  connection: Connection,
  collection: PublicKey,
  onProgress?: (note: string) => void,
): Promise<Holder[] | null> {
  // the owner scan is the slow half, so it starts at once and is dropped when there are no pieces
  const owners = nftOwners(connection)
  owners.catch(() => {})
  const found = await Promise.all(
    COLLECTION_AT.map((at) =>
      connection.getProgramAccounts(METADATA_PROGRAM, {
        filters: [{ memcmp: { offset: at, bytes: SOME_VERIFIED } }, { memcmp: { offset: at + 2, bytes: collection.toBase58() } }],
        dataSlice: { offset: 33, length: 32 },
      }),
    ),
  )
  const mints = found.flat().map((a) => new PublicKey(a.account.data).toBase58())
  if (!mints.length) return null
  onProgress?.(`Finding who holds ${mints.length.toLocaleString('en-US')} pieces…`)
  const ownerOf = await owners
  const byOwner = new Map<string, Holder>()
  for (const mint of mints) {
    const owner = ownerOf.get(mint)
    if (!owner) continue // burnt
    const h = byOwner.get(owner)
    if (h) {
      h.amount += 1n
      h.accounts += 1
    } else {
      // a frozen (staked) piece still counts: its owner holds it
      byOwner.set(owner, { owner, amount: 1n, accounts: 1, isProgram: !PublicKey.isOnCurve(new PublicKey(owner).toBytes()), frozen: false })
    }
  }
  return [...byOwner.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
}

/** Mint to owner for every token account on the chain that holds exactly one token: every NFT, in one call. */
async function nftOwners(connection: Connection): Promise<Map<string, string>> {
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 64, bytes: AMOUNT_ONE } }],
    dataSlice: { offset: 0, length: 64 },
  })
  const ownerOf = new Map<string, string>()
  for (const { account } of accounts) ownerOf.set(new PublicKey(account.data.subarray(0, 32)).toBase58(), new PublicKey(account.data.subarray(32, 64)).toBase58())
  return ownerOf
}
