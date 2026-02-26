# Railgun Internals — Do Not Modify Without Discussion

These Solidity files are adapted from the Railgun open-source codebase. They implement the core ZK shielded pool mechanics: commitment hashing, nullifier tracking, Merkle tree updates, and SNARK proof verification.

**Do not modify these files without explicit human approval.** Changes here can silently break ZK circuit compatibility — the contracts will compile successfully, but proof generation/verification will fail at runtime. There are no compile-time checks that catch circuit incompatibility.

## Files

- `RailgunSmartWallet.sol` — Top-level entry point for shield/transact operations.
- `RailgunLogic.sol` — Core shielded transaction logic.
- `Commitments.sol` — Note commitment creation and Merkle tree insertion.
- `Snark.sol` — SNARK proof verification wrapper. Contains the `VERIFICATION_BYPASS` POC shortcut.
- `Verifier.sol` — Groth16 pairing-based verifier (BN254 curve).
- `Poseidon.sol` — Poseidon hash function (circuit-compatible, BN254 field).
- `Globals.sol` — Shared constants and struct definitions.
- `TokenBlocklist.sol` — Token allow/blocklist management.
