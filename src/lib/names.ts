import { PublicKey, type Connection } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import { isPubkey } from './chain'

/**
 * `.cook` names (CookOven's name service). Crumbs only reads the registry: a name resolves to the
 * wallet that owns it, and a wallet shows the name it set as primary. Two account types matter.
 *   Domain  ["domain", label]  = 8 disc | borsh string name | owner | resolver | metadata | i64 | bump
 *   Primary ["primary", owner] = 8 disc | owner | borsh string name (empty once cleared) | bump
 * Layouts verified against every live account on mainnet, 2026-09-10.
 */
export const NAMES_PROGRAM = new PublicKey('H43Qtq4AMQ86y7yc3YtCKZJ2QMhhnCcHyZKeFeoQn7PA')
export const TLD = '.cook'

const DOMAIN_DISC = [35, 146, 98, 112, 13, 230, 231, 153]
const PRIMARY_DISC = [231, 255, 61, 63, 142, 184, 254, 42]
const enc = new TextEncoder()
const dec = new TextDecoder()

/** "Alice.cook " → "alice". A bare label passes through lowercased and trimmed. */
export function toLabel(input: string): string {
  const s = input.trim().toLowerCase()
  return s.endsWith(TLD) ? s.slice(0, -TLD.length) : s
}

export const withTld = (label: string) => label + TLD

/** A label the program would accept: 1 to 32 bytes of a-z, 0-9 and hyphens, no hyphen at either end. */
export function isLabel(label: string): boolean {
  return label.length > 0 && enc.encode(label).length <= 32 && /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-')
}

/** Read this input as a name? An explicit .cook suffix always is; otherwise a valid label that is not a public key. */
export function looksLikeName(input: string): boolean {
  const s = input.trim()
  if (s.toLowerCase().endsWith(TLD)) return true
  return isLabel(s.toLowerCase()) && !isPubkey(s)
}

export const domainPda = (label: string) => PublicKey.findProgramAddressSync([enc.encode('domain'), enc.encode(label)], NAMES_PROGRAM)[0]
export const primaryPda = (owner: PublicKey) => PublicKey.findProgramAddressSync([enc.encode('primary'), owner.toBytes()], NAMES_PROGRAM)[0]

const hasDisc = (d: Uint8Array, disc: number[]) => d.length >= 8 && disc.every((b, i) => d[i] === b)
const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true)

export function decodeDomain(d: Uint8Array): { name: string; owner: PublicKey } | null {
  if (!hasDisc(d, DOMAIN_DISC) || d.length < 12) return null
  const len = u32(d, 8)
  const end = 12 + len
  if (!len || end + 32 > d.length) return null
  return { name: dec.decode(d.subarray(12, end)), owner: new PublicKey(d.subarray(end, end + 32)) }
}

/** The primary label, or null when the wallet never set one or cleared it. */
export function decodePrimary(d: Uint8Array): string | null {
  if (!hasDisc(d, PRIMARY_DISC) || d.length < 44) return null
  const len = u32(d, 40)
  return len && 44 + len <= d.length ? dec.decode(d.subarray(44, 44 + len)) : null
}

const TTL = 5 * 60_000
const forward = new Map<string, { at: number; owner: PublicKey | null }>()
const reverse = new Map<string, { at: number; name: string | null }>()

/** One name → the wallet that owns it, null when it is not registered. */
export async function resolveName(connection: Connection, input: string): Promise<PublicKey | null> {
  return (await resolveNames(connection, [input])).get(input) ?? null
}

/** Many names at once, one RPC call per hundred. Keys are the inputs as given; unregistered names map to null. */
export async function resolveNames(connection: Connection, inputs: string[]): Promise<Map<string, PublicKey | null>> {
  const out = new Map<string, PublicKey | null>()
  const pending: { input: string; label: string }[] = []
  const now = Date.now()
  for (const input of inputs) {
    const label = toLabel(input)
    if (!isLabel(label)) {
      out.set(input, null)
      continue
    }
    const hit = forward.get(label)
    if (hit && now - hit.at < TTL) out.set(input, hit.owner)
    else pending.push({ input, label })
  }
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(chunk.map((p) => domainPda(p.label)))
    chunk.forEach((p, j) => {
      const owner = infos[j] ? (decodeDomain(infos[j]!.data)?.owner ?? null) : null
      forward.set(p.label, { at: now, owner })
      out.set(p.input, owner)
    })
  }
  return out
}

/** Wallet → its primary name with the suffix, for every wallet that set one. */
export async function primaryNames(connection: Connection, owners: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const pending: string[] = []
  const now = Date.now()
  for (const o of new Set(owners)) {
    const hit = reverse.get(o)
    if (hit && now - hit.at < TTL) {
      if (hit.name) out.set(o, hit.name)
    } else pending.push(o)
  }
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(chunk.map((o) => primaryPda(new PublicKey(o))))
    chunk.forEach((o, j) => {
      const label = infos[j] ? decodePrimary(infos[j]!.data) : null
      const name = label ? withTld(label) : null
      reverse.set(o, { at: now, name })
      if (name) out.set(o, name)
    })
  }
  return out
}

/** Primary names for the wallets on screen, filled in as they resolve. The map only changes when a new name arrives. */
export function usePrimaryNames(connection: Connection, owners: string[]): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(() => new Map())
  const key = owners.join(',')
  useEffect(() => {
    if (!key) return
    let live = true
    primaryNames(connection, key.split(','))
      .then((found) => {
        if (!live || !found.size) return
        setNames((prev) => {
          let grew = false
          for (const [o, n] of found) if (prev.get(o) !== n) grew = true
          return grew ? new Map([...prev, ...found]) : prev
        })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [connection, key])
  return names
}
