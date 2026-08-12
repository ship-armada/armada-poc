// ABOUTME: One-shot schema-version migration that wipes legacy v1 shielded-wallet state on first run of v2.
// ABOUTME: Synchronous localStorage purge + asynchronous IndexedDB purge; App.tsx awaits before the engine init kicks off.

import { SCHEMA_VERSION } from '@/lib/crypto/eip712'
import { track, trackError } from '@/lib/telemetry'

/**
 * localStorage key holding the integer schema version of the persisted shielded-wallet state.
 * Missing or `< SCHEMA_VERSION` triggers a wipe of all v1 state.
 *
 * The on-disk artifacts a v1 user would have:
 *  - `armada.shielded.walletId` — opaque SDK walletId, identity-bound (different in v2)
 *  - `armada.shielded.checksum` — anti-phish display string for the v1 root_secret
 *  - IndexedDB database `armada-shielded` — SDK-encrypted wallet blob keyed by v1 walletId
 *  - IndexedDB store `txHistory` — historical transaction records (currently plaintext;
 *    Phase 7 introduces encryption)
 *
 * Per the redesign plan (.context/shielded-wallet-redesign-plan.md §2.4), this is a hard cut:
 * the v1 → v2 schema fork in eip712.ts means a v1 walletId never re-derives from a v2 sign.
 * Leaving the orphaned blob behind would just bloat IDB; clearing it makes the new sign-in
 * land in a clean state.
 */
const SCHEMA_VERSION_KEY = 'armada.shielded.schemaVersion'

/** localStorage keys that are tied to a specific schema version. */
const LEGACY_KEYS = ['armada.shielded.walletId', 'armada.shielded.checksum'] as const

/**
 * IndexedDB databases dropped on a schema fork.
 *
 * - `armada-shielded`: owned by the SDK; holds the encrypted v1 wallet blob keyed by
 *   v1 walletId. Useless once we re-derive under v2.
 * - `armada-interface`: owned by `lib/cache.ts`; holds tx history, fee quotes, ENS resolutions,
 *   shielded balance snapshots. We drop the whole DB rather than clearing individual stores so
 *   we don't race with the cache module's `onupgradeneeded` setup (opening without a matching
 *   `(version, onupgradeneeded)` pair would create an empty DB without the expected stores).
 *   `cache.ts` re-creates the structure on its next open; the only data lost is short-lived
 *   caches that re-populate naturally (fees auto-refresh, ENS re-resolves on demand). Tx
 *   history is the only thing we actively want gone, and dropping the whole DB takes care of it.
 */
const DROPPED_DATABASES = ['armada-shielded', 'armada-interface'] as const

export function readStoredSchemaVersion(): number {
  try {
    const raw = window.localStorage.getItem(SCHEMA_VERSION_KEY)
    if (!raw) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function writeStoredSchemaVersion(version: number): void {
  try {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, String(version))
  } catch {
    // Quota / disabled-storage failures are non-fatal; the migration will simply re-attempt
    // on the next boot. Better to lose the version marker than to abort cold boot entirely.
  }
}

function clearLegacyLocalStorage(): void {
  for (const key of LEGACY_KEYS) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Same rationale as above — non-fatal.
    }
  }
}

function deleteIndexedDbDatabase(name: string): Promise<void> {
  return new Promise(resolve => {
    try {
      const req = window.indexedDB.deleteDatabase(name)
      // We treat success / error / blocked identically — the only ways a delete fails are
      // (a) another tab has the DB open (`blocked`), and (b) IDB is unavailable. In either
      // case the next sign-in's SDK init will overwrite the relevant rows, so blocking cold
      // boot on a clean drop isn't worth it.
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Idempotent migration runner. Synchronous portion (localStorage) completes first so any
 * downstream code that reads `readStoredWalletId()` sees clean state immediately. Async
 * portion (IDB) runs in parallel; callers SHOULD await the returned promise before initializing
 * the SDK to avoid racing against the SDK's `armada-shielded` open.
 *
 * Returns `null` if no migration is needed (schemaVersion is already current).
 */
export async function runSchemaMigrationIfNeeded(): Promise<void> {
  const stored = readStoredSchemaVersion()
  if (stored >= SCHEMA_VERSION) {
    return
  }

  // Synchronous: clear v1 localStorage so any code reading it during this same tick sees null.
  clearLegacyLocalStorage()

  // Asynchronous: drop IDB databases in parallel. We don't error-propagate per the "non-fatal"
  // rationale above — the SDK and cache module will recreate what they need on next open.
  try {
    await Promise.all(DROPPED_DATABASES.map(deleteIndexedDbDatabase))
    writeStoredSchemaVersion(SCHEMA_VERSION)
    track('shielded.schema-migration', { from: stored, to: SCHEMA_VERSION })
  } catch (err) {
    // We don't expect this branch — the helpers above swallow their own errors. Telemetered
    // so we notice if something changes upstream.
    trackError('schema-migration', err, { scope: 'shielded.schema-migration', message: 'unexpected migration error' })
  }
}
