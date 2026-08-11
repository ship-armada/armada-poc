# lib/

Pure logic — **no React imports allowed.** These modules are unit-testable with plain vitest (no jsdom).

| File / dir | Purpose | Status |
|---|---|---|
| `rpc.ts` | `FallbackJsonRpcProvider` + `createProvider`. Duplicated from crowdfund-shared. | Working |
| `cache.ts` | Generic IndexedDB helpers (`cacheGet/Put/Delete/All/Clear`) keyed by store name. | Working |
| `format.ts` | `formatUsdc`, `truncateAddress`, etc. Duplicated from crowdfund-shared. | Working |
| `revert.ts` | `mapRevertToMessage(err)` for wallet + relayer errors. | Working |
| `wagmi-adapter.ts` | `walletClientToSigner(walletClient)` — viem → ethers v6 signer. Duplicated from committer. | Working |
| `telemetry.ts` | `track / trackTxTransition / trackError`. Console always; `trackError` also forwards the full error to Sentry via `sentry.ts::captureError` (no-op unless a DSN is configured). | Working |
| `sentry.ts` | `initSentry` (DSN-gated no-op) + `captureError` + `scrubString`/`scrubEvent`. Errors-only, `sendDefaultPii: false`, `beforeSend` redacts 0zk/EVM addresses + long hex. Source-map upload is configured in `vite.config.ts` (`@sentry/vite-plugin`, gated on `SENTRY_AUTH_TOKEN`). | Working |
| `relayer.ts` | HTTP client for `/fees`, `/relay`, `/status/:txHash`. **Stub** — signatures only. | Stub |
| `cctp.ts` | `MessageSent` log parsing + `pollIrisOnce`. **Stub.** | Stub |
| `railgun/wallet.ts` | V2 signIn / unlockFromRootSecret / unlockFromBackup / lockWallet / resetWallet. Per-(EVM address, account) `armada.shielded.walletIds` + `armada.shielded.checksums` localStorage maps. | Working |
| `railgun/schema-migration.ts` | V2 cold-boot migration — drops legacy v1 localStorage keys + the SDK/cache IndexedDB databases when `armada.shielded.schemaVersion < 2`. | Working |
| `railgun/keyManager.ts` | Module-scope unlocked-state singleton: `rootSecret`, `walletId`, `sdkEncryptionKey`, `historyEncryptionKey` (Phase 7), `evmAddress` + `account` binding, address, checksum. Getters throw when locked; `clear()` zeroizes secret buffers. | Working |
| `crypto/cache-cipher.ts` | V2 Phase 7 — AES-256-GCM `wrap` / `unwrap` envelope helpers used by `lib/tx/storage` for at-rest encryption of tx records under `historyEncryptionKey`. BigInt round-trip via JSON sentinel. | Working |
| `crypto/determinism.ts` | V2 Phase 2a — typed `NonDeterministicSignerError` + `verifySignatureDeterminism(reSign, firstSig)` used by `useShieldedWallet.signIn` to double-sign on first-ever sign-in for an EVM address. | Working |
| `railgun/network.ts` | Pure-ethers hub-chain RPC helpers — `timeoutProvider`, `getCurrentHubBlock`, `getHubBlockTimestamps`. No engine coupling. | Working |
| `railgun/sync.ts` | Facade over the SDK-native `railgun/balance-bus.ts` (scan/balance/note fan-out + scan-status → `syncStateAtom`) + `refreshShieldedBalances` (`railgun/sdk-read.ts` `wallet.sync()`). Shielded reads come from `railgun/sdk-read.ts` (@armada/sdk). | Working |
| `tx/` | Tx lifecycle model — see `tx/CLAUDE.md`. | Working (types) + Stub (poller integration) |

## Conventions

- **No React imports.** If you reach for `useState`/`useEffect` here, you're in the wrong file — that's a hook.
- **No business logic in `components/**` — push it down here.** ESLint rule planned for the import check.
- **Stubs throw on call.** Better to fail loudly during development than to return fake data and confuse downstream consumers. Hooks that call into stubs should be marked `// TODO: implement` until the corresponding lib function is real.
- **Never log secrets.** No `console.log`/`console.debug` of mnemonics, viewing/spending keys, or anything derived from them. The eslint guard is configured to fail builds in `lib/railgun/`.
- **Never emit "railgun" in any runtime string.** Telemetry event names + `trackError` scopes, `console.*` prefixes, thrown-Error messages, and wallet signature prompts MUST NOT contain "railgun" — an outside observer of the telemetry/console stream shouldn't see it (it reveals the fork and confuses more than it clarifies). Stock-engine / shielded-pool telemetry uses **`shielded.*`**; `@armada/sdk` concerns use **`sdk.*`**. This applies only to *emissions*: internal identifiers, import paths (`@/lib/railgun/*`), dep aliases (`type RailgunSdk = @railgun-community/*`), and dev docs may reference Railgun accurately. The sole exception where matching the literal text is required: string-equality checks against the vendored engine's own error messages (e.g. `init.ts`'s benign-noise filter).

## Duplicated-from-shared note

`rpc.ts`, `format.ts`, `wagmi-adapter.ts`, `revert.ts` are duplicated from `@armada/crowdfund-shared/lib/*`. Don't evolve here without keeping the other in sync. When both apps need to diverge OR both need a new utility, extract to `@armada/eth-utils` (see root CLAUDE.md and Plan §19).
