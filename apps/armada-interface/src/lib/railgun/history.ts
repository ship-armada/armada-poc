// ABOUTME: SDK adapter — wraps @railgun-community/wallet's getWalletTransactionHistory and maps the returned items into our TxRecord shape for chain-driven history recovery + incoming-transfer detection.
// ABOUTME: Pure-mappable: historyItemToTxRecord() takes no React/SDK runtime deps so it's unit-testable with hand-rolled fixtures.

import {
  TransactionHistoryItemCategory,
  type TransactionHistoryItem,
  type RailgunHistoryERC20Amount,
  type RailgunHistoryReceiveERC20Amount,
  type RailgunHistorySendERC20Amount,
  type RailgunHistoryUnshieldERC20Amount,
} from '@railgun-community/shared-models'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import type { TxKind, TxRecord } from '@/lib/tx/types'
import { getHubChainDescriptor } from './network'

// Defer the SDK import to runtime — same jsdom-init-crash mitigation as wallet.ts / sync.ts.
type RailgunSdk = typeof import('@railgun-community/wallet')
async function railgunSdk(): Promise<RailgunSdk> {
  return import('@railgun-community/wallet')
}

/**
 * Context the mapper needs to disambiguate categories that don't map 1:1 to our TxKinds.
 *
 *  - `adapterAddress` — the Railgun-side address of `armadaYieldAdapter`. When set, outgoing
 *    transfers whose recipient matches it become `yield-deposit`; incoming transfers whose
 *    sender matches it become `yield-withdraw`. Unset → all transfers fall back to plain
 *    transfer kinds.
 *  - `hubChainId` — used to stamp `walletContext.sourceChainId` on synthesized records. We only
 *    scan hub history today; cross-chain unshield destination correlation is a later pass.
 */
export interface HistoryMapContext {
  hubChainId: number
  adapterAddress?: string
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
 * Convert SDK timestamp (seconds, optional) → ms. Items without a timestamp sort to the bottom
 * — better than dropping the row, since we still have the txid + amount the user cares about.
 */
function tsMs(item: TransactionHistoryItem): number {
  return item.timestamp ? item.timestamp * 1000 : 0
}

/** Normalize an address for comparison: lowercased hex; null/undefined → null. */
function norm(addr: string | null | undefined): string | null {
  return addr ? addr.toLowerCase() : null
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
 * Pick the first concrete amount entry from one of the SDK's per-category arrays. SDK items
 * theoretically carry multiple entries (multi-token shields, batched sends), but our UI is
 * single-token (USDC) — collapsing to the first entry is a safe simplification for v1. Returns
 * null when the array is empty (mapper skips the item).
 */
function firstAmount<T>(arr: ReadonlyArray<T>): T | null {
  return arr.length > 0 ? (arr[0] ?? null) : null
}

/**
 * Reconstruct what the user originally entered for a shield. The SDK's `receiveERC20Amounts[0]`
 * is the on-chain-credited amount AFTER the protocol shield-fee deduction; adding `shieldFee`
 * back recovers the user's input. Falls back to the raw receive amount when `shieldFee` is
 * absent (older SDK versions / Unknown-category items).
 */
function shieldInputAmount(rcv: RailgunHistoryReceiveERC20Amount): bigint {
  const fee = rcv.shieldFee ? BigInt(rcv.shieldFee) : 0n
  return rcv.amount + fee
}

/* ───────────── per-category mappers ───────────── */

function mapShield(
  item: TransactionHistoryItem,
  walletId: string,
  ctx: HistoryMapContext,
): TxRecord<'shield'> | null {
  const rcv = firstAmount(item.receiveERC20Amounts)
  if (!rcv) return null
  const stages = terminalizeStages('shield')
  return {
    id: syntheticTxId(item.txid, item.category),
    kind: 'shield',
    executionState: 'completed',
    stage: stages.stage,
    stagesCompleted: stages.stagesCompleted,
    updatedSeq: 0,
    createdAt: tsMs(item),
    updatedAt: tsMs(item),
    meta: {
      amount: shieldInputAmount(rcv),
      // Synthetic records have no relayer-quoted fee — sentinel empty string. Consumers that
      // need a real cacheId must check `isSyntheticTxId(record.id)` before reading.
      feeCacheId: '',
      fromChainId: ctx.hubChainId,
    },
    artifacts: { sourceTxHash: `0x${item.txid.replace(/^0x/, '')}` },
    walletContext: walletContextFor(walletId, ctx.hubChainId),
  }
}

function mapTransferSend(
  item: TransactionHistoryItem,
  walletId: string,
  ctx: HistoryMapContext,
): TxRecord<'transfer-shielded'> | TxRecord<'yield-deposit'> | null {
  const send = firstAmount(item.transferERC20Amounts)
  if (!send) return null
  const broadcasterFee = item.broadcasterFeeERC20Amount?.amount ?? 0n
  const baseArtifacts = { sourceTxHash: `0x${item.txid.replace(/^0x/, '')}` as const }
  const baseContext = walletContextFor(walletId, ctx.hubChainId)
  // Yield-deposit heuristic: the relay-adapt path makes the adapter the on-chain `recipient`
  // of the unshield leg (per ArmadaYieldAdapter.lendAndShield). When the adapter address is
  // known AND it matches the send's recipientAddress, we relabel; otherwise this is a plain
  // private transfer to another user.
  const recipientLc = norm(send.recipientAddress)
  const adapterLc = norm(ctx.adapterAddress ?? null)
  if (adapterLc && recipientLc === adapterLc) {
    const stages = terminalizeStages('yield-deposit')
    return {
      id: syntheticTxId(item.txid, item.category),
      kind: 'yield-deposit',
      executionState: 'completed',
      stage: stages.stage,
      stagesCompleted: stages.stagesCompleted,
      updatedSeq: 0,
      createdAt: tsMs(item),
      updatedAt: tsMs(item),
      meta: {
        amount: send.amount,
        feeCacheId: '',
        broadcasterFeeAmount: broadcasterFee,
        broadcasterRailgunAddress: '',
      },
      artifacts: baseArtifacts,
      walletContext: baseContext,
    }
  }
  const stages = terminalizeStages('transfer-shielded')
  return {
    id: syntheticTxId(item.txid, item.category),
    kind: 'transfer-shielded',
    executionState: 'completed',
    stage: stages.stage,
    stagesCompleted: stages.stagesCompleted,
    updatedSeq: 0,
    createdAt: tsMs(item),
    updatedAt: tsMs(item),
    meta: {
      amount: send.amount,
      feeCacheId: '',
      // Recipient is private — the on-chain commitment only carries the recipient's NPK, not a
      // viewing-key-resolvable 0zk string. Sentinel 'unknown' so the row renders without
      // pretending we recovered the destination.
      recipient: 'unknown',
      broadcasterFeeAmount: broadcasterFee,
      broadcasterRailgunAddress: '',
    },
    artifacts: baseArtifacts,
    walletContext: baseContext,
  }
}

function mapTransferReceive(
  item: TransactionHistoryItem,
  walletId: string,
  ctx: HistoryMapContext,
):
  | TxRecord<'transfer-shielded-received'>
  | TxRecord<'yield-withdraw'>
  | null {
  const rcv = firstAmount(item.receiveERC20Amounts)
  if (!rcv) return null
  const baseArtifacts = { sourceTxHash: `0x${item.txid.replace(/^0x/, '')}` as const }
  const baseContext = walletContextFor(walletId, ctx.hubChainId)
  // Yield-withdraw heuristic: the adapter re-shields the redeemed USDC back to the user; the
  // receive item then carries the adapter as `senderAddress`. When the adapter address is
  // known AND matches, we relabel; otherwise this is a plain incoming private transfer.
  const senderLc = norm(rcv.senderAddress)
  const adapterLc = norm(ctx.adapterAddress ?? null)
  if (adapterLc && senderLc === adapterLc) {
    const stages = terminalizeStages('yield-withdraw')
    return {
      id: syntheticTxId(item.txid, item.category),
      kind: 'yield-withdraw',
      executionState: 'completed',
      stage: stages.stage,
      stagesCompleted: stages.stagesCompleted,
      updatedSeq: 0,
      createdAt: tsMs(item),
      updatedAt: tsMs(item),
      meta: {
        amount: rcv.amount,
        feeCacheId: '',
        // The original `shares` count isn't recoverable from chain — the redemption side of the
        // adapter consumed an ayUSDC commitment but we only see the resulting USDC commitment
        // here. Sentinel 0n; the UI's amount column is the meaningful number.
        shares: 0n,
        broadcasterFeeAmount: 0n,
        broadcasterRailgunAddress: '',
      },
      artifacts: baseArtifacts,
      walletContext: baseContext,
    }
  }
  const stages = terminalizeStages('transfer-shielded-received')
  return {
    id: syntheticTxId(item.txid, item.category),
    kind: 'transfer-shielded-received',
    executionState: 'completed',
    stage: stages.stage,
    stagesCompleted: stages.stagesCompleted,
    updatedSeq: 0,
    createdAt: tsMs(item),
    updatedAt: tsMs(item),
    meta: {
      amount: rcv.amount,
      ...(rcv.memoText ? { memoText: rcv.memoText } : {}),
    },
    artifacts: baseArtifacts,
    walletContext: baseContext,
  }
}

function mapUnshield(
  item: TransactionHistoryItem,
  walletId: string,
  ctx: HistoryMapContext,
): TxRecord<'unshield-local'> | null {
  const unshield = firstAmount(item.unshieldERC20Amounts)
  if (!unshield) return null
  const stages = terminalizeStages('unshield-local')
  // For v1 we always assume unshield-local. Distinguishing xchain reliably requires correlating
  // the hub burn against a destination-chain `MessageReceived` event by CCTP nonce — heavier
  // scan, deferred. An xchain unshield therefore renders as `unshield-local` post-recovery; the
  // recipient address still resolves correctly because the on-chain unshield emits it in clear.
  return {
    id: syntheticTxId(item.txid, item.category),
    kind: 'unshield-local',
    executionState: 'completed',
    stage: stages.stage,
    stagesCompleted: stages.stagesCompleted,
    updatedSeq: 0,
    createdAt: tsMs(item),
    updatedAt: tsMs(item),
    meta: {
      amount: unshield.amount,
      feeCacheId: '',
      recipient: unshield.recipientAddress ?? 'unknown',
      broadcasterFeeAmount: item.broadcasterFeeERC20Amount?.amount ?? 0n,
      broadcasterRailgunAddress: '',
    },
    artifacts: { sourceTxHash: `0x${item.txid.replace(/^0x/, '')}` },
    walletContext: walletContextFor(walletId, ctx.hubChainId),
  }
}

/**
 * Pure mapper from SDK `TransactionHistoryItem` → `TxRecord | null`. Returns null when:
 *  - The category is `Unknown` (SDK couldn't classify; we don't invent a kind).
 *  - The category's expected per-direction array is empty (corrupted item).
 *
 * Never throws — call sites can `.filter(Boolean)` to drop unmapped items.
 */
export function historyItemToTxRecord(
  item: TransactionHistoryItem,
  walletId: string,
  ctx: HistoryMapContext,
): TxRecord | null {
  switch (item.category) {
    case TransactionHistoryItemCategory.ShieldERC20s:
      return mapShield(item, walletId, ctx)
    case TransactionHistoryItemCategory.TransferSendERC20s:
      return mapTransferSend(item, walletId, ctx)
    case TransactionHistoryItemCategory.TransferReceiveERC20s:
      return mapTransferReceive(item, walletId, ctx)
    case TransactionHistoryItemCategory.UnshieldERC20s:
      return mapUnshield(item, walletId, ctx)
    case TransactionHistoryItemCategory.Unknown:
      return null
  }
}

/**
 * Map a batch of SDK items, dropping the unmapped ones. Sort key matches `loadAllTx`:
 * `updatedAt` descending so freshly-recovered rows appear at the top of the activity feed.
 */
export function historyItemsToTxRecords(
  items: ReadonlyArray<TransactionHistoryItem>,
  walletId: string,
  ctx: HistoryMapContext,
): TxRecord[] {
  const records: TxRecord[] = []
  for (const item of items) {
    const r = historyItemToTxRecord(item, walletId, ctx)
    if (r) records.push(r)
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt)
  return records
}

/**
 * Drive the SDK's `getWalletTransactionHistory` on the hub chain. `startingBlock` lets the SDK
 * skip pre-deploy chain history (cheaper) and resume from a checkpoint on incremental scans.
 *
 * Returns the raw SDK items; mapping happens in `historyItemsToTxRecords` so callers that want
 * pure SDK output (e.g. for telemetry or debugging) can use this directly.
 */
export async function scanWalletHistory(
  walletId: string,
  startingBlock?: number,
): Promise<TransactionHistoryItem[]> {
  const { getWalletTransactionHistory } = await railgunSdk()
  return getWalletTransactionHistory(getHubChainDescriptor(), walletId, startingBlock)
}

/* Re-export the SDK types so consumers don't import @railgun-community directly. */
export type {
  TransactionHistoryItem,
  RailgunHistoryERC20Amount,
  RailgunHistoryReceiveERC20Amount,
  RailgunHistorySendERC20Amount,
  RailgunHistoryUnshieldERC20Amount,
}
