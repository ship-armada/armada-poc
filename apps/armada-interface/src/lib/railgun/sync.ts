// ABOUTME: Shielded-balance sync facade — re-exports the SDK-native balance-change bus (balance-bus)
// ABOUTME: + the wallet.sync() refresh trigger (sdk-read), so consumers keep one import surface.

export { subscribeBalanceUpdates, resetSyncState, type BalanceUpdateEvent } from './balance-bus'
export { refreshShieldedBalances } from './sdk-read'
