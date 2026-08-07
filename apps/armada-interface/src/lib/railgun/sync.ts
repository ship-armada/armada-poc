// ABOUTME: Shielded-balance sync — fan-out wrapper around the SDK's single global onBalanceUpdate callback + a refresh trigger.
// ABOUTME: Pure lib (no React). A bridge hook subscribes and mirrors balances into atoms; reset state for tests via resetSyncState().

import { getHubChainDescriptor, loadHubNetwork } from './network'

// Railgun SDK import is deferred — same jsdom-init-crash mitigation as lib/railgun/wallet.ts.
// One dynamic import per session.
type RailgunSdk = typeof import('@railgun-community/wallet')

async function railgunSdk(): Promise<RailgunSdk> {
  return import('@railgun-community/wallet')
}

/**
 * Shape passed to listeners. We re-export the SDK's RailgunBalancesEvent under a friendlier
 * name so consumers don't depend on the SDK package directly. Fields are a structural subset.
 */
export interface BalanceUpdateEvent {
  readonly chain: { type: 0; id: number }
  readonly railgunWalletID: string
  // Other SDK fields exist (txidVersion, balanceBucket, erc20Amounts, nftAmounts) but
  // consumers should re-query via the @armada/sdk read path — the event is purely a "something
  // changed, refresh your view" signal in our usage.
}

type Listener = (event: BalanceUpdateEvent) => void
const listeners = new Set<Listener>()
let globalCallbackInstalled = false

/**
 * Register the SDK's global callback exactly once, then fan out to every Set member. The SDK
 * only accepts ONE callback at runtime, so we own it and multiplex. Idempotent.
 */
async function ensureGlobalCallback(): Promise<void> {
  if (globalCallbackInstalled) return
  const { setOnBalanceUpdateCallback } = await railgunSdk()
  setOnBalanceUpdateCallback((event: BalanceUpdateEvent) => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* swallow — one bad listener mustn't break the others */
      }
    }
  })
  globalCallbackInstalled = true
}

/**
 * Subscribe to SDK balance update events. The first subscription lazily installs the global
 * SDK callback. Returns an unsubscribe function.
 *
 * Awaits because the first call must wait for the dynamic SDK import to land. Subsequent
 * calls resolve immediately (the await is microtask-only after the SDK is cached).
 */
export async function subscribeBalanceUpdates(listener: Listener): Promise<() => void> {
  await ensureGlobalCallback()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Trigger a balance refresh / merkle scan for the given wallet on the hub chain. Idempotent
 * at the SDK level — if a scan is already running, this is effectively a no-op. The result
 * (updated balance) is delivered asynchronously via the global callback, not the return value.
 */
export async function refreshShieldedBalances(walletId: string): Promise<void> {
  await loadHubNetwork() // idempotent; needed in case caller hasn't pre-loaded
  const { refreshBalances } = await railgunSdk()
  await refreshBalances(getHubChainDescriptor(), [walletId])
}

/** Reset module-scope state — for tests + dev hot-reload scenarios. */
export function resetSyncState(): void {
  listeners.clear()
  globalCallbackInstalled = false
}
