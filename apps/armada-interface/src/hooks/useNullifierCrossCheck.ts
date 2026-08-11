// ABOUTME: Runs the WI-5 on-chain nullifier cross-check after each shielded scan completes and writes nullifierCrossCheckAtom.
// ABOUTME: Mount once at App root. No-op while locked or mid-scan; re-checks after a Try-Again re-sync. The gate hook only reads the atom.

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeShieldedWalletAtom, nullifierCrossCheckAtom, syncStateAtom } from '@/state/wallet'
import { checkOwnNullifiersOnChain } from '@/lib/shielded/nullifierCrossCheck'
import { trackError } from '@/lib/telemetry'

/**
 * After the initial (or a re-triggered) shielded scan completes for the unlocked wallet, cross-check
 * the wallet's own unspent notes against the hub PrivacyPool's on-chain nullifier set. A watcher
 * that omits a `Nullified` event passes merkleroot validation but shows a spent note as unspent;
 * this catches that and flips `nullifierCrossCheckAtom` to 'omission-detected' so the spend gate
 * blocks (see useSpendableSyncGate).
 *
 * Lifecycle:
 *   - locked / no wallet        → reset atom to 'unknown'
 *   - unlocked, scan not done   → wait (also clears the per-completion dedupe so a re-sync re-checks)
 *   - unlocked, scan complete   → run the check once, write 'ok' | 'omission-detected'
 *
 * The `latestWalletIdRef` guards stale-closure writes if the wallet flips mid-check.
 */
export function useNullifierCrossCheck(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const sync = useAtomValue(syncStateAtom)
  const setCrossCheck = useSetAtom(nullifierCrossCheckAtom)
  const latestWalletIdRef = useRef<string | null>(null)
  // Dedupe: run at most once per scan-completion, not on every re-render while status is 'complete'.
  const checkedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (active?.status !== 'unlocked') {
      latestWalletIdRef.current = null
      checkedForRef.current = null
      setCrossCheck('unknown')
      return
    }

    const walletId = active.id
    latestWalletIdRef.current = walletId

    // Only meaningful once the scan is done (tree + own notes populated). Clearing the dedupe here
    // means a Try-Again re-sync (which passes back through 'syncing') re-runs the check on the next
    // completion. The atom keeps its prior value during the re-sync so a standing block persists.
    if (sync.status !== 'complete') {
      checkedForRef.current = null
      return
    }
    if (checkedForRef.current === walletId) return
    checkedForRef.current = walletId

    let cancelled = false
    void (async () => {
      try {
        const result = await checkOwnNullifiersOnChain(walletId)
        if (cancelled || latestWalletIdRef.current !== walletId) return
        setCrossCheck(result.omissionDetected ? 'omission-detected' : 'ok')
      } catch (err) {
        // checkOwnNullifiersOnChain already fails open internally; guard the hook boundary too.
        trackError('useNullifierCrossCheck', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active?.status, active?.id, sync.status, setCrossCheck])
}
