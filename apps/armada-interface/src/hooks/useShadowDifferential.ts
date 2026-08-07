// ABOUTME: Phase A read-path shadow — runs the @armada/sdk read differential when the shielded USDC
// ABOUTME: balance settles and reports parity (address + balance + history) via telemetry. Dev-gated; no behavior change.

import { useEffect, useRef } from 'react'
import { runShadowDifferential, closeShadowSdk, sdkReadPathEnabled } from '../lib/railgun/shadow-sdk'
import { isUnlocked } from '../lib/railgun/keyManager'
import { track } from '../lib/telemetry'

/** A validation probe, not a user feature — on in `dev` (not tests), or opt-in via VITE_SHADOW_SDK=1. */
const SHADOW_ENABLED =
  import.meta.env.MODE === 'development' || import.meta.env.VITE_SHADOW_SDK === '1'

/**
 * Observe read-path parity between @armada/sdk and the stock engine. Runs once per distinct settled
 * engine USDC balance, compares 0zk address + balance + history, and emits a `railgun.shadow`
 * telemetry line. Never changes app state; failures are reported, not thrown into render.
 */
export function useShadowDifferential(engineUsdcBalance: bigint | undefined): void {
  const lastRun = useRef<bigint | null>(null)

  useEffect(() => {
    // When the read-path cutover flag is on, useShieldedBalanceSync owns the SDK instance (it drives
    // the balance); the shadow comparison is redundant and must not touch the instance.
    if (!SHADOW_ENABLED || sdkReadPathEnabled()) return
    if (engineUsdcBalance === undefined || !isUnlocked()) {
      // Locked or not yet synced — tear down the persistent shadow instance (idempotent).
      lastRun.current = null
      void closeShadowSdk()
      return
    }
    if (lastRun.current === engineUsdcBalance) return
    lastRun.current = engineUsdcBalance

    let cancelled = false
    void (async () => {
      try {
        const cmp = await runShadowDifferential(engineUsdcBalance)
        if (cancelled) return
        track('railgun.shadow', {
          addressMatch: cmp.addressMatch,
          balanceMatch: cmp.balanceMatch,
          sdkBalance: cmp.sdkUsdcBalance.toString(),
          engineBalance: cmp.engineUsdcBalance.toString(),
          historyCount: cmp.historyCount,
          syncedThrough: cmp.syncedThrough,
        })
      } catch (err) {
        if (cancelled) return
        track('railgun.shadow', {
          addressMatch: false,
          balanceMatch: false,
          sdkBalance: '0',
          engineBalance: engineUsdcBalance.toString(),
          historyCount: 0,
          syncedThrough: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [engineUsdcBalance])
}
