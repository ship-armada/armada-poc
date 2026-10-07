# Legacy POC Files

This folder contains the original stub-based POC implementation that has been
superseded. **Nothing under `_legacy/` is part of the build** (Hardhat compiles
`contracts/`, Foundry compiles `contracts/`, CI never references this folder).

## What's Here

### contracts/
- `SimpleShieldAdapter.sol` - Stub MASP with keccak256 commitments (no ZK)
- `ClientShieldProxy.sol` / `ClientShieldProxyV2.sol` / `ClientShieldProxyV3.sol` - V1–V3 shield proxies
- `HubCCTPReceiver.sol` - V1 receiver (uses SimpleShieldAdapter)
- `HubUnshieldProxy.sol` - V1 unshield proxy
- `MockUSDC.sol`, `Delegator.sol` - POC helpers

### lib/
- `note_generator.ts` - Mock commitment generation using keccak256
- `proof_helper.ts` - Mock proof generation (random bytes, no verification)

### scripts/ and test/
- `deploy_hub.ts`, `deploy_client*.ts`, `link_deployments*.ts` - V1-era deploy scripts
- `e2e_shield.ts`, `e2e_transfer.ts`, `e2e_unshield.ts` - V1-era e2e tests

### docs/
- Planning document for the (now completed) ZK-pool
  integration; kept as historical design prose

## Removed 2026-09-28 (M8)

The legacy `contracts/` tree that this folder's V2/V3-era files depended on was
superseded and removed, along with every `_legacy/` file that imported or
deployed it:

- `contracts/HubCCTPReceiverV2.sol`, `contracts/HubCCTPReceiverV3.sol`,
  `contracts/HubUnshieldProxyV3.sol`
- the legacy deploy scripts
- `test/e2e_shield_sdk.ts`, `test/e2e_transfer_sdk.ts`, `test/e2e_unshield_sdk.ts`,
  `test/e2e_shield_v2.ts`, `test/e2e_transfer_v2.ts`, `test/e2e_crosschain_unshield.ts`,
  `test/e2e_multichain.ts`

The current implementation lives in `contracts/privacy-pool/`, with behavioral
equivalence proven by the golden-vector corpus in
`test-foundry/fixtures/contract-vectors/` (see `scripts/contract-vectors/`).

## Current Implementation

The current implementation uses:
- Rewritten pool contracts (`contracts/privacy-pool/`) — original code, MIT
- MIT-licensed SDK for wallets/proofs
- Real Poseidon hash and EdDSA signatures (`lib/wallet.ts`)
- Real Groth16 proof generation (`lib/prover.ts`)

See the main README.md for current usage.
