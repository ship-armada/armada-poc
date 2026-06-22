// ABOUTME: Auto-lock enforcement — arms an idle timer (preferencesAtom.autoLockMinutes), plus tab-hidden grace + tab-unload sync locks per V2 redesign §"Phase 5".
// ABOUTME: Pauses when wallet isn't unlocked, when a non-terminal tx is in flight (don't lock mid-flow), or when unmounted.

import { useEffect, useRef } from 'react'
import { useAtomValue, useStore } from 'jotai'
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
 * Hard cap on how many times the lock is deferred because a tx is "in flight". Each deferral is
 * ~1 minute, so this bounds the extra time keys stay in memory to ~5 minutes past the idle/hidden
 * deadline. Without a cap, a single wedged non-terminal record (counted by pendingTxsAtom) would
 * defer the security lock forever — holding the rootSecret in memory indefinitely. User activity
 * resets the budget. (T-H3)
 */
const MAX_LOCK_DEFERRALS = 5

/**
 * Mount once at the App root. Listens for user activity and locks the shielded wallet after the
 * configured idle period. When a non-terminal tx is in flight, locking is deferred to a minute later
 * so we don't yank the user out of a flow at the worst possible moment.
 */
export function useAutoLock() {
  const prefs = useAtomValue(preferencesAtom)
  const { state, lock } = useShieldedWallet()
  // The contextual store (default store in the app — no jotai Provider; the test's createStore
  // under a Provider). We read pendingTxsAtom from it LIVE inside fire() rather than subscribing
  // via useAtomValue — subscribing here re-rendered the whole App shell on every tx write. (P1-19)
  const store = useStore()

  const isUnlocked = state?.status === 'unlocked'
  const timeoutMs = prefs.autoLockMinutes * 60_000

  // Read at fire time without re-arming the effect on every change.
  const lockRef = useRef(lock)
  lockRef.current = lock

  // Any non-terminal tx in flight? Read live from the store so we don't subscribe (re-render) here.
  const hasInflight = () => store.get(pendingTxsAtom).length > 0

  useEffect(() => {
    if (!isUnlocked) {
      store.set(autoLockDeadlineAtom, null)
      return
    }

    let lastReset = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    // Counts consecutive in-flight deferrals (idle + hidden paths share the budget). Reset by
    // user activity / returning to the tab. Capped at MAX_LOCK_DEFERRALS so a wedged record can't
    // hold keys forever. (T-H3)
    let deferrals = 0

    function fire() {
      if (hasInflight() && deferrals < MAX_LOCK_DEFERRALS) {
        // Defer for a minute and re-check; locking mid-flow is worse than waiting a bit — but only
        // up to the cap, after which we lock regardless to bound key-in-memory time.
        deferrals += 1
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
      deferrals = 0 // user is present → restore the full deferral budget
      if (timer) clearTimeout(timer)
      store.set(autoLockDeadlineAtom, now + timeoutMs)
      timer = setTimeout(fire, timeoutMs)
    }

    // Tab-hidden grace: when the document goes hidden, arm a 5-minute timer. If the user comes
    // back before it fires, cancel it (resume normal idle behavior). If grace expires while
    // still hidden, lock — deferring just like the idle path when a tx is in flight, so we
    // don't yank the user out of mid-broadcast even when they've walked away.
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null

    // The grace (or a prior deferral) elapsed while still hidden. Lock unless a tx is in flight and
    // we still have deferral budget — in which case re-check in 60s. W-8: the re-check is a clean
    // 60s tick, NOT a fresh 5-min grace, so a wedged in-flight tx holds keys ~grace+5min, not ~30min.
    function hiddenLockCheck() {
      if (hasInflight() && deferrals < MAX_LOCK_DEFERRALS) {
        deferrals += 1
        hiddenTimer = setTimeout(hiddenLockCheck, 60_000)
        return
      }
      lockRef.current()
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        if (hiddenTimer) clearTimeout(hiddenTimer)
        hiddenTimer = setTimeout(hiddenLockCheck, HIDDEN_GRACE_MS)
      } else if (hiddenTimer) {
        clearTimeout(hiddenTimer)
        hiddenTimer = null
        deferrals = 0 // returned to the tab → restore the deferral budget
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
  }, [isUnlocked, timeoutMs, store])
}
