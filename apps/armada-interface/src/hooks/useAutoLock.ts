// ABOUTME: Auto-lock enforcement — arms an idle timer (preferencesAtom.autoLockMinutes), plus tab-hidden grace + tab-unload sync locks per V2 redesign §"Phase 5".
// ABOUTME: Pauses when wallet isn't unlocked, when a non-terminal tx is in flight (don't lock mid-flow), or when unmounted.

import { useEffect, useRef } from 'react'
import { getDefaultStore, useAtomValue } from 'jotai'
import { useShieldedWallet } from './useShieldedWallet'
import { preferencesAtom } from '@/state/preferences'
import { pendingTxsAtom } from '@/state/tx'
import { autoLockDeadlineAtom } from '@/state/wallet'

/** Activity events we treat as a sign of user presence. Passive listeners — no preventDefault. */
const ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
  'pointermove',
]

/** How long to debounce activity resets — caps the cost of mousemove-style storms. */
const RESET_THROTTLE_MS = 1000

/**
 * How long the tab can stay hidden before we auto-lock — 5 minutes.
 *
 * Hidden ≠ idle: a user may briefly switch tabs to copy an address, check a notification, or
 * follow a link from a confirmation email. Locking instantly on `visibilityState === 'hidden'`
 * would punish those legitimate flows. A 5-minute grace covers the common case while still
 * locking faster than the idle timer for tabs the user has clearly walked away from.
 *
 * Not configurable in v1 — adding a preference here trades UX surface area for a marginal
 * security tweak, and the 5-min default lands in the same ballpark as MetaMask's own
 * background-tab behavior so most users won't notice the difference.
 */
const HIDDEN_GRACE_MS = 5 * 60_000

/**
 * Mount once at the App root. Listens for user activity and locks the shielded wallet after the
 * configured idle period. When a non-terminal tx is in flight, locking is deferred to a minute later
 * so we don't yank the user out of a flow at the worst possible moment.
 */
export function useAutoLock() {
  const prefs = useAtomValue(preferencesAtom)
  const pending = useAtomValue(pendingTxsAtom)
  const { state, lock } = useShieldedWallet()

  const isUnlocked = state?.status === 'unlocked'
  const timeoutMs = prefs.autoLockMinutes * 60_000

  // Refs for values that should be read at fire time without re-arming the effect on every change.
  const hasInflightRef = useRef(pending.length > 0)
  hasInflightRef.current = pending.length > 0
  const lockRef = useRef(lock)
  lockRef.current = lock

  useEffect(() => {
    const store = getDefaultStore()
    if (!isUnlocked) {
      store.set(autoLockDeadlineAtom, null)
      return
    }

    let lastReset = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    function fire() {
      if (hasInflightRef.current) {
        // Defer for a minute and re-check; locking mid-flow is worse than waiting a bit.
        const next = Date.now() + 60_000
        store.set(autoLockDeadlineAtom, next)
        timer = setTimeout(fire, 60_000)
        return
      }
      lockRef.current()
    }

    function reset() {
      const now = Date.now()
      if (now - lastReset < RESET_THROTTLE_MS) return
      lastReset = now
      if (timer) clearTimeout(timer)
      store.set(autoLockDeadlineAtom, now + timeoutMs)
      timer = setTimeout(fire, timeoutMs)
    }

    // Tab-hidden grace: when the document goes hidden, arm a 5-minute timer. If the user comes
    // back before it fires, cancel it (resume normal idle behavior). If grace expires while
    // still hidden, lock — deferring just like the idle path when a tx is in flight, so we
    // don't yank the user out of mid-broadcast even when they've walked away.
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        if (hiddenTimer) clearTimeout(hiddenTimer)
        hiddenTimer = setTimeout(() => {
          if (hasInflightRef.current) {
            // Same defer policy as the main fire() — re-check in a minute. Don't lock mid-flow.
            hiddenTimer = setTimeout(onVisibilityChange, 60_000)
            return
          }
          lockRef.current()
        }, HIDDEN_GRACE_MS)
      } else if (hiddenTimer) {
        clearTimeout(hiddenTimer)
        hiddenTimer = null
      }
    }

    // Tab-unload sync lock: best-effort zeroize the keyManager before the page is torn down.
    // `lockWallet` clears the keyManager synchronously before its own internal await; the SDK's
    // unloadWalletByID promise gets orphaned but that's OK — the engine itself is dying with
    // the page. The point is to clear the in-memory rootSecret buffer one extra time before
    // V8 starts reclaiming everything, so a process-memory snapshot taken in the milliseconds
    // around the close has fewer bytes to recover.
    function onBeforeUnload() {
      lockRef.current()
    }

    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, reset, { passive: true }))
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('beforeunload', onBeforeUnload)
    // Arm the initial timer.
    store.set(autoLockDeadlineAtom, Date.now() + timeoutMs)
    timer = setTimeout(fire, timeoutMs)

    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, reset))
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (timer) clearTimeout(timer)
      if (hiddenTimer) clearTimeout(hiddenTimer)
      store.set(autoLockDeadlineAtom, null)
    }
  }, [isUnlocked, timeoutMs])
}
