// ABOUTME: Derives spendable private USDC from completed tx history when Railgun sync has not written shieldedUsdcAtom yet.
// ABOUTME: Prefer live chain balance when available; history is a device-local ledger fallback (same rows as Activity).

import type { TxRecord, TxKind } from '@/lib/tx/types'

const CREDIT: ReadonlySet<TxKind> = new Set(['shield', 'shield-xchain', 'yield-withdraw'])
const DEBIT: ReadonlySet<TxKind> = new Set([
  'unshield-local',
  'unshield-xchain',
  'transfer-shielded',
  'yield-deposit',
])

/**
 * Net private USDC implied by completed txs on this device.
 * Matches what users see in Recent activity / History (deposits add, withdraws/send/vault subtract).
 */
export function computePrivateUsdcFromTxHistory(records: ReadonlyArray<TxRecord>): bigint {
  let total = 0n
  for (const record of records) {
    if (record.executionState !== 'completed') continue
    const { amount } = record.meta
    if (CREDIT.has(record.kind)) {
      total += amount
    } else if (DEBIT.has(record.kind)) {
      total -= amount
    }
  }
  return total > 0n ? total : 0n
}
