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

/**
 * Scan-progress status — drives the sync banner / gate (`syncStateAtom`). Mapped from the SDK's scan
 * events: `scan:started` → syncing/0, `scan:progress` → syncing/fraction, `scan:complete` → complete/1,
 * `scan:error` → failed. Carried on a separate channel from the balance ping because it needs the
 * progress fraction + status (the balance bus is a bare trigger).
 */
export interface SyncStatusEvent {
  readonly status: 'syncing' | 'complete' | 'failed'
  readonly progress: number // 0..1
}

type StatusListener = (event: SyncStatusEvent) => void
const statusListeners = new Set<StatusListener>()

/** Fan a scan-status change out to every listener. Called by sdk-read's scan `wallet.on(...)` forwarders. */
export function emitScanStatus(event: SyncStatusEvent): void {
  for (const listener of statusListeners) {
    try {
      listener(event)
    } catch {
      /* swallow — one bad listener mustn't break the others */
    }
  }
}

/** Subscribe to scan-status changes. Returns an unsubscribe fn. */
export function subscribeScanStatus(listener: StatusListener): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Reset module-scope state — for tests + dev hot-reload scenarios. */
export function resetSyncState(): void {
  listeners.clear()
  statusListeners.clear()
}
