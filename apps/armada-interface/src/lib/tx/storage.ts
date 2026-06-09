// ABOUTME: Tx record persistence with optimistic concurrency — IDB writes are stale-rejected via updatedSeq.
// ABOUTME: Stores ALL records (pending + terminal) so the History page can render them.

import { cacheAll, cacheDelete, cacheGet, cachePut } from '../cache'
import { trackError } from '../telemetry'
import type { TxRecord } from './types'

const STORE = 'txHistory' as const

/**
 * Upsert a tx record with optimistic concurrency:
 *  - If no existing record, write the incoming.
 *  - If existing.updatedSeq < incoming.updatedSeq, write the incoming.
 *  - Else reject (returns false, emits telemetry).
 *
 * Returns true if the write went through, false if it was a stale write.
 */
export async function putTxIfFresh(record: TxRecord): Promise<boolean> {
  try {
    const existing = await cacheGet<TxRecord>(STORE, record.id)
    if (existing && existing.updatedSeq >= record.updatedSeq) {
      trackError('tx.storage.stale-write', new Error('stale updatedSeq'), {
        scope: 'tx.storage',
        message: `stale write rejected for ${record.id}`,
      })
      return false
    }
    await cachePut(STORE, record.id, record)
    return true
  } catch (err) {
    trackError('tx.storage.putTxIfFresh', err, { scope: 'tx.storage', message: 'idb write failed' })
    throw err
  }
}

/** Unconditional write — only for hydration paths or tests. Most callers want putTxIfFresh. */
export async function putTx(record: TxRecord): Promise<void> {
  await cachePut(STORE, record.id, record)
}

export async function deleteTx(id: string): Promise<void> {
  await cacheDelete(STORE, id)
}

/**
 * Hydrate tx records from IDB. When `walletId` is supplied (Phase 6: history scoping), only
 * records bound to that walletId are returned — others are skipped without being deserialized
 * into the in-memory atom. When omitted, returns [] (no wallet is active → nothing to surface).
 *
 * The pre-Phase-6 unscoped behavior is gone: callers MUST pass the active walletId. Anything
 * else would re-leak records from prior wallets into the new session. Records on disk are still
 * wallet-mixed in v1 (no IDB-key partitioning in Phase 6); Phase 7 layers per-wallet AES-GCM
 * encryption that makes foreign records undecryptable, completing the isolation.
 */
export async function loadAllTx(walletId?: string): Promise<TxRecord[]> {
  if (!walletId) return []
  const entries = await cacheAll<TxRecord>(STORE)
  return entries
    .map(e => e.value)
    .filter(r => r.walletContext.railgunWalletId === walletId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
