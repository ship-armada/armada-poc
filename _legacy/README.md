# Legacy POC Files

This folder contains the original stub-based POC implementation that has been superseded by the real Railgun integration.

## What's Here

### contracts/
- `SimpleShieldAdapter.sol` - Stub MASP with keccak256 commitments (no ZK)
- `ClientShieldProxy.sol` - V1 shield proxy (uses SimpleShieldAdapter)
- `HubCCTPReceiver.sol` - V1 receiver (uses SimpleShieldAdapter)

### lib/
- `note_generator.ts` - Mock commitment generation using keccak256
- `proof_helper.ts` - Mock proof generation (random bytes, no verification)

### test/
- `e2e_shield.ts` - Tests V1 shield flow (SimpleShieldAdapter)
- `e2e_transfer.ts` - Tests V1 transfer (no ZK proofs)
- `e2e_unshield.ts` - Tests V1 unshield

### docs/
- `DEMO_POC_RAILGUN.md` - Planning document for Railgun integration (now completed)

## Current Implementation

The current implementation uses:
- Real Railgun contracts (`contracts/railgun/`)
- Real Poseidon hash and EdDSA signatures (`lib/wallet.ts`)
- Real Groth16 proof generation (`lib/prover.ts`)
- V2 contracts that integrate with Railgun (`ClientShieldProxyV2`, `HubCCTPReceiverV2`)

See the main README.md for current usage.
