# hooks/

One concern per hook. Hooks own the React lifecycle (effects, subscriptions, timers) and bridge `lib/` (pure logic) to `state/` (atoms). Components consume hooks and atoms; they never call `lib/` directly.

| Hook | Concern | Status |
|---|---|---|
| `useTabVisible()` | Sole `visibilitychange` listener → `tabVisibleAtom`. Mount once at App root. | Working |
| `useAutoLock()` | Idle-timer-driven lock for the shielded wallet; reads `preferencesAtom.autoLockMinutes`. **V2 Phase 5**: also wires `beforeunload` (sync lock on tab close) and `visibilitychange` (5-min hidden-tab grace before lock). Mount once at App root. | Working |
| `useWallet()` | wagmi state + ethers signer via `walletClientToSigner`. Mirrors `evmAddressAtom`. **V2 Phase 4**: auto-locks the shielded wallet on EVM-account switch (`wagmi.address !== keyManager.getEvmAddress()`), resets active-wallet atoms, surfaces a sonner toast. | Working |
| `useShieldedWallet()` | Railgun wallet lifecycle: `signIn(account?)` (V2 primary — EIP-712 sign → root_secret, with first-sign double-verification for non-deterministic wallet detection) / `unlockByPaste(hex)` / `unlockByBackup(file, passphrase)` / `exportBackup(passphrase)` / `lock()` / `reset()`. `enroll()` is a deprecated alias for `signIn(0n)`. | Working |
| `useBalances()` | Aggregated balance view (unshielded per chain, shielded, yield shares). | Reads atoms only; shielded is now live via `useShieldedBalanceSync` |
| `useShieldedBalanceSync()` | Subscribes to SDK balance events + drives initial scan on unlock; writes `shieldedUsdcAtom`. Re-runs on `syncRetryEpochAtom` bump (Try Again) and marks `syncStateAtom` failed when the scan can't start. Mount once at App root. | Working |
| `useSyncRetry()` | Returns a `retry()` for the "Try Again" affordance on a failed initial sync — optimistically sets `syncStateAtom` to syncing, then bumps `syncRetryEpochAtom`. Used by `SyncGate`, `SyncBanner`, `BalanceHero`. | Working |
| `useHistoryRecovery()` | V1 Phase 9 — on unlock, runs `runHistoryScan` against the SDK and persists synthetic records for chain history not already in IDB. Dedupes against authored records by `artifacts.sourceTxHash`. Re-runs when `historyRecoveryEpochAtom` bumps (Settings → Re-scan). Mount once at App root. | Working |
| `useIncomingTransferDetector()` | V1 Phase 9 — subscribes to SDK balance events and bumps `historyRecoveryEpochAtom` so the recovery hook fetches the delta. Surfaces received-transfer rows live. Mount once at App root. | Working |
| `useNowTicker()` | Bumps `nowAtom` every 60s so relative-time labels refresh without navigation. Mount once at App root. | Working |
| `useRailgunEngineSync()` | Bridges `lib/railgun/init`'s lifecycle into `railgunEngineAtom`. Mount once at App root. | Working |
| `useYieldRate()` | Polls vault rate + net APY (gross spoke yield × vault fee) via React Query (visibility-paused, 5min cadence). Exposes `refresh()` for on-open + post-submit pulls. | Working |
| `useFees()` | `/fees` quote via React Query — auto-refreshes near expiry, exponential cold-start backoff, dedups across consumers. | Working |
| `useTx({ kind })` | Per-tx submit/track/retry/cancel. Multi-instance — each call owns a ulid. | Working — all kinds run end-to-end via registered handlers; submit/retry/cancel wired |
| `useTxHistory()` | Hydrates `txListAtom` from IDB on `activeRailgunWalletIdAtom` change (V2 Phase 6); clears the atom on lock. Only hydrates records belonging to the active walletId. | Working |
| `useTxResume()` | On unlock (leader tab only), calls `executor.resumeForWallet(walletId)` — re-attaches watchers to already-broadcast txs (has `sourceTxHash`) and fails pre-broadcast interruptions as `INTERRUPTED`. Idempotent per (walletId, session). Mount once at App root. | Working |

## Conventions

- **No business logic in components.** Components use hooks; hooks call `lib/` (which has no React).
- **Effects clean up.** Every `useEffect` that starts a timer / subscription / fetch returns a cleanup. `AbortController` for fetches; `removeEventListener` for DOM events; `clearTimeout` for setTimeout.
- **Polling gates on `tabVisibleAtom`.** Don't read `document.visibilityState` from a hook — read the atom.
- **Telemetry calls on state transitions.** Use `track(event, props)` for happy path, `trackError(scope, err)` for caught errors. Make every async path traceable.
- **No memoization theater.** Only `useMemo`/`useCallback` when (a) referential identity matters (deps of another effect) or (b) the computation is genuinely expensive.

## Pattern: per-tx hook is multi-instance

`useTx({ kind })` is intentionally NOT a singleton. Each call generates a fresh ulid on `submit()` and writes a separate `TxRecord` to `txListAtom`. Multiple modal flows can have their own `useTx` instances running concurrently — that's the whole point. Don't memoize the hook at the App level.
