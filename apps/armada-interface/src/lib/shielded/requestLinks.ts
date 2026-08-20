// ABOUTME: Persistence for created payment-request links — encrypted at rest under the per-wallet historyEncryptionKey.
// ABOUTME: Mirrors tx-history storage (AES-256-GCM envelopes in IDB, foreign-wallet records skipped on decrypt).

import { cacheAll, cacheDelete, cachePut } from '@/lib/cache'
import { isEncryptedBlob, unwrap, wrap } from '@/lib/crypto/cache-cipher'
import { getHistoryEncryptionKey, isUnlocked } from '@/lib/shielded/keyManager'
import { trackError } from '@/lib/telemetry'

const STORE = 'requestLinks' as const

/**
 * A payment-request link the user generated. Not a transaction — no chain, no funds; just a local
 * artifact surfaced in Recent Activity (and re-openable at the Share-link step). `amount` is the
 * raw USDC string as entered (bigint isn't JSON-serialisable through the cipher).
 */
export interface RequestLinkRecord {
  requestId: string
  paymentLink: string
  amount: string
  note?: string
  expiresAt: number
  createdAt: number
  shieldedWalletId: string
}

/** Encrypt + persist one link under the active wallet's key. No-op when locked (can't encrypt). */
export async function saveRequestLink(record: RequestLinkRecord): Promise<void> {
  if (!isUnlocked()) return
  try {
    await cachePut(STORE, record.requestId, wrap(record, getHistoryEncryptionKey()))
  } catch (err) {
    trackError('shielded.requestLinks.save', err, {
      scope: 'shielded.requestLinks',
      message: 'idb write failed',
    })
  }
}

/** Load + decrypt this wallet's links. Foreign-wallet envelopes fail AES-GCM auth and are skipped. */
export async function loadRequestLinks(walletId?: string): Promise<RequestLinkRecord[]> {
  if (!walletId || !isUnlocked()) return []
  const key = getHistoryEncryptionKey()
  const rows = await cacheAll<unknown>(STORE)
  const out: RequestLinkRecord[] = []
  for (const { value } of rows) {
    if (!isEncryptedBlob(value)) continue
    try {
      const rec = unwrap<RequestLinkRecord>(value, key)
      if (rec.shieldedWalletId === walletId) out.push(rec)
    } catch {
      // Different wallet's record (wrong key) or corrupt blob — invisible by design.
    }
  }
  return out
}

/** Delete this wallet's links (e.g. Clear-history / Reset). Requires an unlocked wallet to scope. */
export async function clearRequestLinks(walletId?: string): Promise<void> {
  const links = await loadRequestLinks(walletId)
  for (const link of links) {
    await cacheDelete(STORE, link.requestId)
  }
}
