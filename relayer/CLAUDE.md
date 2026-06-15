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
