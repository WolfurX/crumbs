import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

const key = (owner: PublicKey) => `crumbs.session.${owner.toBase58()}`

/** The browser keypair that signs clicks and purchases. Holds pocket change only; claims pay the owner. */
export function loadSession(owner: PublicKey): Keypair | null {
  try {
    const raw = localStorage.getItem(key(owner))
    return raw ? Keypair.fromSecretKey(bs58.decode(raw)) : null
  } catch {
    return null
  }
}

export function createSession(owner: PublicKey): Keypair {
  const kp = Keypair.generate()
  localStorage.setItem(key(owner), bs58.encode(kp.secretKey))
  return kp
}

export function importSession(owner: PublicKey, secret: string): Keypair {
  const kp = Keypair.fromSecretKey(bs58.decode(secret.trim()))
  localStorage.setItem(key(owner), bs58.encode(kp.secretKey))
  return kp
}

export function exportSession(kp: Keypair): string {
  return bs58.encode(kp.secretKey)
}

export function forgetSession(owner: PublicKey) {
  localStorage.removeItem(key(owner))
}
