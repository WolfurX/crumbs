import type { Connection } from '@solana/web3.js'
import { COOK_MINT } from './chain'
import { loadRegistry } from './tokens'

export interface ChainStats {
  slot: number
  epoch: number
  epochPct: number
  txCount: number
  tps: number
  cookUsd: number | null
  tokens: number
}

/** One round of live network numbers: epoch, slot, throughput, COOK price, indexed tokens. */
export async function fetchStats(connection: Connection): Promise<ChainStats> {
  const [epoch, samples, registry] = await Promise.all([
    connection.getEpochInfo(),
    connection.getRecentPerformanceSamples(4).catch(() => []),
    loadRegistry().catch(() => new Map()),
  ])
  const txs = samples.reduce((n, s) => n + s.numTransactions, 0)
  const secs = samples.reduce((n, s) => n + s.samplePeriodSecs, 0)
  const cook = registry.get(COOK_MINT)?.priceUsd ?? null
  return {
    slot: epoch.absoluteSlot,
    epoch: epoch.epoch,
    epochPct: (epoch.slotIndex / epoch.slotsInEpoch) * 100,
    txCount: epoch.transactionCount ?? 0,
    tps: secs ? txs / secs : 0,
    cookUsd: cook,
    tokens: registry.size,
  }
}
