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

## Important Notes

- Express v5 has different error handling and routing patterns than v4. Notably: async route handlers propagate errors automatically, and `req.params` is a plain object (not a prototype of `Object`).
- The relayer holds a Railgun wallet that must be initialized before processing transactions. If the wallet fails to initialize, the relayer will not start the HTTP server.
