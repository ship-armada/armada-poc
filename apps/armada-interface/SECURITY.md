# armada-interface — security notes

Security-relevant design decisions and residual risks for the user app. Companion to
`DEPLOYMENT.md` (env/config) and `../../.claude/PLAN_ARMADA_INTERFACE.md` (§security boundary).

## Shielded quick-sync trust model (F5)

The app can hydrate the Railgun engine's client-side commitment merkletree from our relayer-v2
**watcher** (`VITE_INDEXER_URL` → `GET /v1/quick-sync/:hubChainId`) instead of an O(chain-length)
`eth_getLogs` scan. The watcher is **untrusted** — it must only be able to cause *sync failure*,
never *forged or inflated balances*. Two independent on-chain checks enforce that; the chain is the
sole root of trust.

### 1. Merkleroot validation (forged-balance defense)

After the engine rebuilds the commitment tree from quick-sync data, it validates **every** tree's
computed root against the hub PrivacyPool's on-chain `rootHistory(treeNumber, root)` before
decrypting any balance (`@railgun-community/engine` `scanUTXOHistory`). A watcher that injects or
mutates commitments produces a root the chain never recorded → the engine throws `Invalid
merkleroot` → the scan is marked `Incomplete` → `syncStateAtom` goes `failed` → the spend gate
blocks. No forged balance is ever displayed or spendable. This is **automatic** in the engine once
the network is loaded with the real PrivacyPool address (via the `NetworkName.Hardhat` masquerade's
`proxyContract` + `loadProvider`); F5 adds no custom root-validation code.

### 2. Nullifier cross-check (omitted-spend defense)

Nullifiers are **not** in the commitment merkletree, so root validation cannot catch an *omitted*
`Nullified` event: a watcher that serves commitments faithfully but drops a nullifier makes an
already-spent note look unspent → an **inflated displayed balance** (never actually spendable — the
chain rejects the double-spend — but misleading UX and a footgun).

`lib/railgun/nullifierCrossCheck.ts` closes this gap. After each scan completes,
`useNullifierCrossCheck` reads the wallet's own locally-unspent notes (`wallet.TXOs`, each carrying
its `tree` + `nullifier`) and queries the hub PrivacyPool's `nullifiers(treeNumber, nullifier)`
getter directly. If the chain reports an own "unspent" note as spent → `nullifierCrossCheckAtom`
flips to `omission-detected` → the spend gate blocks with a re-sync prompt.

**Fail-open:** the cross-check is a UX-integrity safeguard, not the double-spend boundary (the chain
enforces that regardless). A transient hub-RPC error must not block spending, so on error it logs
and reports no omission. A malicious watcher cannot trigger this path — the check hits the chain
RPC, not the watcher.

### Degradation (B4)

With `VITE_INDEXER_URL` unset, the quick-sync client returns empty and the engine falls back to its
slow on-chain scan. Both safety checks operate identically on the slow-scan tree. The app is fully
functional with no indexer configured.

## Residual risks

- **P6 — nullifier query IP linkability (testnet: accepted).** The nullifier cross-check queries the
  wallet's own nullifiers directly, letting the RPC provider link them to the user's IP when those
  notes are later spent on-chain. **Accepted for testnet** — it matches the exposure the app already
  has (every RPC read goes to the same provider). **Mainnet follow-up:** batch the lookups via
  multicall mixed with decoy nullifiers sampled from the global commitment stream, so the provider
  can't isolate the user's own set. Tracked for the mainnet hardening pass.
- **Engine version lockstep (B3).** The watcher decodes hub logs into engine-`9.5.1`
  `AccumulatedEvents` shapes, compile-time pinned. Bumping `@railgun-community/engine` here requires
  a paired watcher type-pin PR in `ship-armada/armada-relayer` in the same change window.
