// ABOUTME: SDK-native shielded balance-change bus — fans out the @armada/sdk wallet's scan/balance/note
// ABOUTME: events to app listeners. A leaf module (imports nothing) so sdk-read + sync can both use it.

/**
 * Shape passed to listeners — purely a "something changed, refresh your view" ping. `reason` names the
 * @armada/sdk event that triggered it (`scan` = scan:complete, `balance` = balance:updated, `note` =
 * note:received). Consumers re-query balances/history via the SDK read path; the payload carries no
 * amounts or addresses (those live on the typed SDK events, but the app treats this as a trigger).
 */
export interface BalanceUpdateEvent {
  readonly reason: 'scan' | 'balance' | 'note'
}

type Listener = (event: BalanceUpdateEvent) => void
const listeners = new Set<Listener>()

/** Fan a wallet event out to every listener. Called by sdk-read's `wallet.on(...)` forwarders. */
export function emitBalanceChange(event: BalanceUpdateEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      /* swallow — one bad listener mustn't break the others */
    }
  }
}

/** Subscribe to balance-change pings. Returns an unsubscribe fn. Async for call-site compatibility. */
export async function subscribeBalanceUpdates(listener: Listener): Promise<() => void> {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reset module-scope state — for tests + dev hot-reload scenarios. */
export function resetSyncState(): void {
  listeners.clear()
}
