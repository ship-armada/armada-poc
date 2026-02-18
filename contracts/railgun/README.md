# Railgun Reference Implementation

These contracts are **reference implementations** from the Railgun design. They are **not deployed** in the POC.

## Role in This POC

- **PrivacyPool** (in `contracts/privacy-pool/`) is the deployed shielded pool. Its modules (TransactModule, ShieldModule) reimplement the core logic.
- **Shared pieces** (Globals, Poseidon, Snark) in this directory are imported by PrivacyPool and its modules.
- **RailgunSmartWallet**, **RailgunLogic**, and related contracts are kept for design reference and potential future alignment.

## Key Contracts

| Contract | Purpose |
|----------|---------|
| `Globals.sol` | Shared types (Transaction, BoundParams, CommitmentPreimage, etc.) |
| `Poseidon.sol` | Poseidon hash library (used by Merkle, commitments) |
| `Snark.sol` | Groth16 verification |
| `RailgunSmartWallet.sol` | Original Railgun entry point (not deployed) |
| `RailgunLogic.sol` | Original transact/shield logic (reference only) |
