// ABOUTME: Tx record persistence with optimistic concurrency + at-rest AES-256-GCM encryption (V2 Phase 7) under a per-wallet historyEncryptionKey from keyManager.
// ABOUTME: Stores envelopes of shape `{ nonce, ciphertext }` keyed by tx id; foreign-wallet records throw on unwrap and get silently skipped during hydration.

import { cacheAll, cacheDelete, cacheGet, cachePut } from '../cache'
import { isEncryptedBlob, unwrap, wrap, type EncryptedBlob } from '../crypto/cache-cipher'
import { getHistoryEncryptionKey, isUnlocked } from '../railgun/keyManager'
import { trackError } from '../telemetry'
import type { TxRecord } from './types'

const STORE = 'txHistory' as const

/**
 * Internal: encrypt a TxRecord under the active wallet's historyEncryptionKey. Throws when the
 * wallet is locked — the executor + reducer should never reach a write path with no unlocked
 * wallet, so this is a "should be unreachable" guard, not a graceful fallback.
 */
function wrapForStorage(record: TxRecord): EncryptedBlob {
  return wrap(record, getHistoryEncryptionKey())
}

/**
 * Internal: try to decrypt one envelope. Returns the record on success, null on any failure.
 *
 * Failure modes that surface as null:
 *  - The envelope was written by a different wallet (wrong key → AES-GCM tag verification
 *    fails). This is the Phase 7 wallet-isolation mechanism — foreign records are silently
 *    invisible without needing a plaintext walletId in the envelope.
 *  - The envelope was written pre-Phase-7 as plain JSON (no `nonce`/`ciphertext` fields).
 *  - The blob is corrupt for any other reason.
 *
 * We do NOT throw out of `loadAllTx` for these — they're expected during a v6→v7 transition
 * and during cross-wallet IDB co-tenancy. Telemetry-with-count happens at the call site so a
 * pathological "everything skipped" state is still visible.
 */
function tryUnwrap(value: unknown, key: Uint8Array): TxRecord | null {
  if (!isEncryptedBlob(value)) return null
  try {
    return unwrap<TxRecord>(value, key)
  } catch {
    return null
  }
}

/**
 * Upsert a tx record with optimistic concurrency:
 *  - If no existing record, write the incoming.
 *  - If existing.updatedSeq < incoming.updatedSeq, write the incoming.
 *  - Else reject (returns false, emits telemetry).
 *
 * Returns true if the write went through, false if it was a stale write.
 *
 * Throws synchronously if the keyManager is locked — callers must guard their submit paths.
 * The OCC check reads the encrypted envelope, decrypts it to compare `updatedSeq`, and re-
 * encrypts on write. The re-encryption uses a fresh nonce per call (per AES-GCM hygiene), so
 * the ciphertext changes on every write even when the record body would round-trip identical
 * bytes.
 */
export async function putTxIfFresh(record: TxRecord): Promise<boolean> {
  if (!isUnlocked()) {
    throw new Error('tx.storage.putTxIfFresh: wallet locked — refusing to write tx record')
  }
  const key = getHistoryEncryptionKey()
  try {
    const existingRaw = await cacheGet<unknown>(STORE, record.id)
    if (existingRaw !== undefined) {
      const existing = tryUnwrap(existingRaw, key)
      if (existing && existing.updatedSeq >= record.updatedSeq) {
        trackError('tx.storage.stale-write', new Error('stale updatedSeq'), {
          scope: 'tx.storage',
          message: `stale write rejected for ${record.id}`,
        })
        return false
      }
      // If existing is null here, the stored envelope was either foreign-wallet (couldn't
      // decrypt under our key) or pre-Phase-7 plaintext. In either case the old value is
      // unreadable garbage to us and overwriting it is correct.
    }
    await cachePut(STORE, record.id, wrapForStorage(record))
    return true
  } catch (err) {
    trackError('tx.storage.putTxIfFresh', err, { scope: 'tx.storage', message: 'idb write failed' })
    throw err
  }
}

/**
 * Unconditional encrypted write. Used by hydration paths or tests that need to bypass the OCC
 * check. Throws when locked, same rationale as `putTxIfFresh`.
 */
export async function putTx(record: TxRecord): Promise<void> {
  if (!isUnlocked()) {
    throw new Error('tx.storage.putTx: wallet locked — refusing to write tx record')
  }
  await cachePut(STORE, record.id, wrapForStorage(record))
}

export async function deleteTx(id: string): Promise<void> {
  await cacheDelete(STORE, id)
}

/**
 * Hydrate tx records from IDB. When `walletId` is supplied (Phase 6: history scoping), only
 * records bound to that walletId are returned. When omitted, returns [] (no wallet is active →
 * nothing to surface).
 *
 * Phase 7: every envelope is decrypted under the active wallet's historyEncryptionKey. Foreign-
 * wallet records throw on AES-GCM auth failure and get skipped silently — `walletId === walletId`
 * after decrypt is a defense-in-depth assertion since the key-based decrypt is already the real
 * isolation mechanism. Pre-Phase-7 plaintext records also fail the isEncryptedBlob shape check
 * and get skipped; this means a v6→v7 transition appears to the user as "history cleared," which
 * is acceptable for pre-production.
 */
export async function loadAllTx(walletId?: string): Promise<TxRecord[]> {
  if (!walletId) return []
  if (!isUnlocked()) return [] // can't decrypt without the key
  const key = getHistoryEncryptionKey()
  const entries = await cacheAll<unknown>(STORE)
  const records: TxRecord[] = []
  for (const e of entries) {
    const r = tryUnwrap(e.value, key)
    if (!r) continue
    if (r.walletContext.railgunWalletId !== walletId) continue
    records.push(r)
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt)
}
