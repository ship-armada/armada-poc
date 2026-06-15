# Relayer

The Armada relayer is a Node.js service (Express v5, ethers v6) that submits shielded transactions on behalf of users and relays CCTP cross-chain messages.

## Module Structure

- `armada-relayer.ts` — Entry point. Orchestrates all modules and starts the HTTP server.
- `config.ts` — Environment and network configuration loading.
- `types.ts` — Shared TypeScript types for the relayer.

### Modules (`modules/`)

- `wallet-manager.ts` — Manages the relayer's Railgun-compatible shielded wallet.
- `fee-calculator.ts` — Estimates gas costs and generates fee schedules. Quotes are cached with a 5-minute TTL.
- `privacy-relay.ts` — Receives shielded transactions from users and pays gas on-chain.
- `http-api.ts` — Express v5 server exposing `/relay` and `/fees` endpoints on port 3001.
- `cctp-relay.ts` — Local/mock CCTP relay: polls chains for pending burn events and calls `CCTPHookRouter.relayWithHook()`.
- `iris-relay.ts` — Production CCTP relay using Circle's Iris attestation service (Sepolia/mainnet).

### Libraries (`lib/`)

- `nonce-coordinator.ts` — Process-wide per-chain nonce authority shared by the privacy relay and the CCTP relay (both sign from one EOA; without it their nonce streams collide and replace each other's txs).
- `json-state-store.ts` — Atomic, schema-versioned, per-key JSON persistence with per-key write serialisation. Backs the cursor / pending / retry-queue / dead-letter stores.
- `cursor-store.ts`, `pending-state-store.ts`, `retry-queue-store.ts`, `dead-letter-store.ts` — Typed stores over `json-state-store` (see `state/README.md` for the on-disk files).
- `rate-limiter.ts` — In-process per-IP token bucket + `clientKey` helper for the HTTP API.
- `rpc-utils.ts` (`withTimeout`), `get-logs-chunked.ts`, `rpc-bisecting.ts`, `health-classifier.ts` — RPC/scan/health helpers.

## Environment variables

Beyond the network/CCTP config in `config/*.env`, the relayer reads:

- `RELAYER_PRIVATE_KEY` — dedicated hot-wallet key (see "Relayer key" below). Falls back to the deployer key.
- `RELAYER_RATE_LIMIT_RELAY_PER_MIN` (default 10), `RELAYER_RATE_LIMIT_GET_PER_MIN` (default 60) — per-IP HTTP rate limits.
- `RELAYER_TRUST_PROXY` (default off) — honour `X-Forwarded-For` for the rate-limit key (only behind a known reverse proxy).
- `RELAYER_MAX_BODY_BYTES` (default 256KB) — JSON request body limit.
- `RELAYER_RAILGUN_MNEMONIC` (required) / `BROADCASTER_RAILGUN_ADDRESS` — relayer `0zk` wallet for broadcaster-fee verification.
- Per-chain scanner knobs (`RELAYER_<KNOB>_<CHAIN>`) and Iris/CCTP timing — see `config.ts`.

## CCTP Modes

Controlled by `CCTP_MODE` env var:
- `mock` — `cctp-relay.ts` handles relay directly without attestation (local Anvil only).
- `real` — `iris-relay.ts` polls Circle's Iris API for attestations before relaying (Sepolia).

## Relayer key

The relayer's EVM hot wallet (used by `wallet-manager.ts`, `iris-relay.ts`, and `cctp-relay.ts` to sign on every chain) is resolved by `config.ts::relayerPrivateKey`:

- If `RELAYER_PRIVATE_KEY` is set, that dedicated key is used.
- Otherwise it falls back to the deployer key, with a loud boot warning on non-local environments.

Use a dedicated `RELAYER_PRIVATE_KEY` (set in gitignored `config/secrets.env`) in any shared/VPS deployment so a relayer-host compromise is not also a deployer/admin-key compromise. Fund the address with a small ETH balance on each chain the relayer submits to. Per-chain key splits remain future hardening.

## Important Notes

- Express v5 has different error handling and routing patterns than v4. Notably: async route handlers propagate errors automatically, and `req.params` is a plain object (not a prototype of `Object`).
- The relayer holds a Railgun wallet that must be initialized before processing transactions. If the wallet fails to initialize, the relayer will not start the HTTP server.
