// ABOUTME: History adapter — maps @armada/sdk HistoryEntry values into our TxRecord shape for chain-driven history recovery + incoming-transfer detection.
// ABOUTME: Pure-mappable: historyEntryToTxRecord() takes no React runtime deps so it's unit-testable with hand-rolled fixtures.

import { lifecycleFor } from '@/lib/tx/lifecycles'
import type { TxKind, TxRecord } from '@/lib/tx/types'
import { getHubBlockTimestamps } from './network'
import { syncSdkHistory } from './sdk-read'
import type { HistoryEntry } from '@armada/sdk'

/**
 * Context the mapper needs to stamp records.
 *
 *  - `hubChainId` — used to stamp `walletContext.sourceChainId` on synthesized records. We only
 *    scan hub history today; cross-chain unshield destination correlation is a later pass.
 */
export interface HistoryMapContext {
  hubChainId: number
}

/** Empty default — convenient for tests + the no-yield-detection path. */
export const EMPTY_HISTORY_CONTEXT: HistoryMapContext = { hubChainId: 0 }

/**
 * Deterministic synthetic-record id. Encoded as `synth:${txid}:${category}` so re-running the
 * scan produces the same id and `putTxIfFresh` is a no-op (OCC sees `updatedSeq` 0 ≤ 0). Two
 * different categories on the same txid (e.g. yield-deposit re-shields back as an incoming
 * commitment in the same on-chain tx) produce distinct ids — both rows render.
 *
 * Prefix `synth:` is the marker future code reads to distinguish "reconstructed from chain"
 * from "I authored this" (ulid-shaped) without parsing the rest.
 */
export function syntheticTxId(txid: string, category: string): string {
  return `synth:${txid}:${category}`
}

/**
 * Whether an id was minted by `syntheticTxId`. Used to short-circuit duplicate-row detection
 * during incremental scans (don't synthesize over an already-synthetic row), and to drive
 * future UI affordances ("this row was recovered from chain").
 */
export function isSyntheticTxId(id: string): boolean {
  return id.startsWith('synth:')
}

/**
 * Build the `walletContext` block. We don't know which EVM address the user held at the time
 * of an old tx, so `evmAddress` is undefined on synthesized rows — `TxWalletContext` allows it.
 */
function walletContextFor(
  walletId: string,
  hubChainId: number,
): TxRecord['walletContext'] {
  return {
    evmAddress: undefined,
    railgunWalletId: walletId,
    sourceChainId: hubChainId,
  }
}

/**
 * Synthesize a finished record: born `executionState: 'completed'` with every stage in the
 * lifecycle counted as completed and `stage` parked on the terminal-success stage. The
 * executor's resume probe skips terminal records, so there's no risk of "running" a synthetic.
 */
function terminalizeStages<K extends TxKind>(kind: K): {
  stage: TxRecord<K>['stage']
  stagesCompleted: TxRecord<K>['stagesCompleted']
} {
  const lifecycle = lifecycleFor(kind)
  return {
    stage: lifecycle.terminalSuccess as TxRecord<K>['stage'],
    stagesCompleted: [...lifecycle.stages] as TxRecord<K>['stagesCompleted'],
  }
}

/**
 * High-level scan result handed back to the recovery hook + incoming-transfer detector.
 *
 *  - `records`      — mapped TxRecord[] (filter `Unknown` + corrupt items already applied).
 *  - `highestBlock` — the max `blockNumber` across returned items; null when the scan was empty
 *                     or every item had an undefined block. The caller persists this as the
 *                     next checkpoint so subsequent scans resume from `highestBlock + 1`.
 *  - `itemCount`    — total SDK items the scan returned (mapped + unmapped). Drives telemetry
 *                     so we know if `Unknown`-heavy histories are slipping through.
 */
export interface HistoryScanResult {
  records: TxRecord[]
  highestBlock: number | null
  itemCount: number
}

/**
 * Map an @armada/sdk `HistoryEntry` → `TxRecord`. The SDK classifies yield deposit/withdraw
 * natively and carries recipient + fee + memo inline. `value` is a signed wallet delta
 * (negative = outflow); `timestampMs` is resolved by the caller from `blockNumber`. Returns
 * null only if a future SDK category isn't handled here.
 */
export function historyEntryToTxRecord(
  entry: HistoryEntry,
  walletId: string,
  ctx: HistoryMapContext,
  timestampMs: number,
): TxRecord | null {
  const sourceTxHash = `0x${entry.txid.replace(/^0x/, '')}` as const
  const walletContext = walletContextFor(walletId, ctx.hubChainId)
  const abs = entry.value < 0n ? -entry.value : entry.value
  const broadcasterFee = entry.broadcasterFee ?? 0n
  const artifacts = { sourceTxHash }
  const times = { updatedSeq: 0, createdAt: timestampMs, updatedAt: timestampMs } as const

  switch (entry.category) {
    case 'shield': {
      const stages = terminalizeStages('shield')
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'shield', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: { amount: entry.value + (entry.shieldFee ?? 0n), feeCacheId: '', fromChainId: ctx.hubChainId },
      }
    }
    case 'transfer-received': {
      const stages = terminalizeStages('transfer-shielded-received')
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'transfer-shielded-received', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: { amount: entry.value, ...(entry.memo ? { memoText: entry.memo } : {}) },
      }
    }
    case 'transfer-sent': {
      const stages = terminalizeStages('transfer-shielded')
      const recipientAmount = entry.sentOutputs?.reduce((a, o) => a + o.value, 0n) ?? abs - broadcasterFee
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'transfer-shielded', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: {
          amount: recipientAmount, feeCacheId: '',
          recipient: entry.sentOutputs?.[0]?.recipientRailgunAddress ?? 'unknown',
          broadcasterFeeAmount: broadcasterFee, broadcasterRailgunAddress: '',
        },
      }
    }
    case 'unshield': {
      const stages = terminalizeStages('unshield-local')
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'unshield-local', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: {
          amount: abs - broadcasterFee - (entry.unshieldFee ?? 0n), feeCacheId: '',
          recipient: entry.recipient ?? 'unknown',
          broadcasterFeeAmount: broadcasterFee, broadcasterRailgunAddress: '',
        },
      }
    }
    case 'yield-deposit': {
      const stages = terminalizeStages('yield-deposit')
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'yield-deposit', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: { amount: abs, feeCacheId: '', broadcasterFeeAmount: broadcasterFee, broadcasterRailgunAddress: '' },
      }
    }
    case 'yield-withdraw': {
      const stages = terminalizeStages('yield-withdraw')
      return {
        id: syntheticTxId(entry.txid, entry.category), kind: 'yield-withdraw', executionState: 'completed',
        stage: stages.stage, stagesCompleted: stages.stagesCompleted, ...times, artifacts, walletContext,
        meta: { amount: entry.value, feeCacheId: '', shares: 0n, broadcasterFeeAmount: 0n, broadcasterRailgunAddress: '' },
      }
    }
    default:
      return null
  }
}

/**
 * Single entry point for both first-time recovery and ongoing incoming-transfer detection. Syncs
 * the @armada/sdk wallet, maps its history entries to `TxRecord`s, and surfaces a checkpoint
 * candidate (`highestBlock`). The SDK doesn't stamp a timestamp on every chain, so block times are
 * backfilled in bulk from `getHubBlockTimestamps` (entries without a recovered timestamp keep 0 and
 * sort to the bottom of the feed). Deliberately does NOT touch IDB or atoms — that's the hook's job.
 */
export async function runHistoryScan(
  walletId: string,
  ctx: HistoryMapContext,
  fromBlock: number | undefined,
): Promise<HistoryScanResult> {
  const entries = await syncSdkHistory(fromBlock)
  const blocks = [...new Set(entries.map(e => e.blockNumber))]
  const timestamps = blocks.length > 0 ? await getHubBlockTimestamps(blocks) : new Map<number, number>()

  const records: TxRecord[] = []
  let highest: number | null = null
  for (const entry of entries) {
    const seconds = timestamps.get(entry.blockNumber)
    const record = historyEntryToTxRecord(entry, walletId, ctx, seconds !== undefined ? seconds * 1000 : 0)
    if (record) records.push(record)
    if (highest === null || entry.blockNumber > highest) highest = entry.blockNumber
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt)
  return { records, highestBlock: highest, itemCount: entries.length }
}
