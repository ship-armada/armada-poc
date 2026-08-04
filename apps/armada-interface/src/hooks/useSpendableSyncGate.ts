// ABOUTME: Gates spend-flow Confirm buttons while the shielded balance sync is incomplete.
// ABOUTME: Returns { blocked, reason } — modals disable submit + show the reason as a tooltip.

import { useAtomValue } from 'jotai'
import { nullifierCrossCheckAtom, shieldedUsdcAtom, syncStateAtom } from '@/state/wallet'

export interface SpendableSyncGate {
  /** True when the user should not be allowed to submit a spend-flow tx yet. */
  readonly blocked: boolean
  /** User-facing explanation when blocked. Null when not blocked. */
  readonly reason: string | null
}

/**
 * Returns whether a "spend the user's shielded balance" flow can safely proceed.
 *
 * The Railgun engine runs an initial historical scan the first time a wallet is unlocked on
 * a device — until that completes, `shieldedUsdcAtom` is null (we don't know the user's actual
 * balance). Letting the user submit a transfer/unshield/yield-deposit/yield-withdraw against
 * "null balance" is incoherent: they'd either submit zero amount (with a confusing error) or
 * submit using the rate they typed in (overspending the not-yet-discovered UTXOs).
 *
 * Block only on first-sync conditions:
 *   - status === 'syncing' AND shieldedUsdcAtom === null  → "wait for first sync"
 *   - status === 'failed'                                 → "sync interrupted, reload"
 *   - nullifierCrossCheck === 'omission-detected'         → "balance stale, re-sync" (WI-5)
 *
 * Don't block when:
 *   - The wallet has already seen at least one successful scan (shieldedUsdcAtom !== null),
 *     even if a background refresh is currently in flight. The user knows what they have.
 *   - Shield flows: they don't depend on the shielded balance — they ADD to it. Modals
 *     that wrap shield should NOT call this gate. (ShieldModal doesn't.)
 */
export function useSpendableSyncGate(): SpendableSyncGate {
  const sync = useAtomValue(syncStateAtom)
  const shielded = useAtomValue(shieldedUsdcAtom)
  const nullifierCrossCheck = useAtomValue(nullifierCrossCheckAtom)

  if (sync.status === 'failed') {
    return {
      blocked: true,
      reason: 'Shielded-balance sync was interrupted. Use "Try again" on the dashboard before submitting.',
    }
  }

  // WI-5: merkleroot validation can't see an omitted Nullified event, so an already-spent note can
  // show as unspent (inflated balance). The on-chain nullifier cross-check catches that; block here
  // so the user re-syncs instead of submitting a spend that would revert on-chain as a double-spend.
  if (nullifierCrossCheck === 'omission-detected') {
    return {
      blocked: true,
      reason: 'Your shielded balance may be out of date — a spent note was not reported by the indexer. Use "Try again" on the dashboard to re-sync before submitting.',
    }
  }

  if (sync.status === 'syncing' && shielded === null) {
    return {
      blocked: true,
      reason: 'Loading your private balance — please wait for the initial sync to finish.',
    }
  }

  return { blocked: false, reason: null }
}
