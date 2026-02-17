# Threat Model: Privacy Pool

**Domain:** PrivacyPool, modules (Shield, Transact, Merkle, Verifier), RelayAdapt, PrivacyPoolClient  
**Date:** 2025-02-13

---

## Architecture Summary

- **PrivacyPool (Hub):** Main router; holds state via PrivacyPoolStorage; delegates to modules via delegatecall.
- **Modules:** ShieldModule, TransactModule, MerkleModule, VerifierModule — logic only, no state.
- **RelayAdapt:** Cross-contract calls; unshield → multicall → shield. Proof binds adapt params.
- **PrivacyPoolClient:** Client-chain bridge; initiates cross-chain shields, receives unshields via CCTP.

---

## Threat Table

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| PP-01 | **Nullifier reuse** | Double-spend by reusing a nullifier | `nullifiers[treeNum][nullifier]` check before marking spent; revert if already true | Invariant tests (MerkleHandler) |
| PP-02 | **Invalid Merkle root** | Proof references non-existent or stale root | `rootHistory[treeNumber][merkleRoot]` must be true | TransactModule._validateTransaction |
| PP-03 | **Proof verification bypass** | Fake or invalid SNARK proof accepted | VerifierModule.verify() with Groth16; testingMode only for POC | Integration tests |
| PP-04 | **Testing mode in production** | testingMode=true bypasses all proof verification | Owner-only setTestingMode; MUST be false for mainnet | Config tests |
| PP-05 | **RelayAdapt arbitrary calls** | Multicall executes user-specified targets with pool funds | Proof commits to adaptParams (keccak256(nullifiers, txCount, actionData)); mismatch reverts | RelayAdapt.relay checks |
| PP-06 | **RelayAdapt PrivacyPool bypass** | Multicall calls PrivacyPool directly to drain | `if (call.to != address(privacyPool))` blocks direct calls | RelayAdapt._multicall |
| PP-07 | **CCTP message replay** | Replay same CCTP message to double-mint | CCTP protocol handles nonce; MockCCTP uses nextNonce++ | CCTP protocol |
| PP-08 | **Wrong recipient on unshield** | Unshield sends to wrong address | Proof commits to unshield preimage; recipient derived from npk/commitment | TransactModule._transferTokenOut |
| PP-09 | **Fee manipulation** | User avoids fee or protocol loses fee | Fee computed from commitment preimage; _getFee proven in Halmos | HalmosFee.t.sol |
| PP-10 | **Module upgrade / malicious delegatecall** | Owner sets malicious module address | Owner is trusted; init has zero-checks; no upgrade path in POC | Access control |
| PP-11 | **CCTP domain spoofing** | Unshield to wrong chain or fake remote pool | remotePools[domain] validated; destinationDomain != localDomain | _validateAtomicUnshieldInputs |
| PP-12 | **Commitment collision** | Two different notes produce same commitment | Poseidon hash collision resistance; negligible probability | Cryptographic assumption |
| PP-13 | **tx.origin bypass (VERIFICATION_BYPASS)** | Attacker uses tx.origin to bypass proof | Only for gas estimation; MUST not be reachable in production | Document; remove for mainnet |
| PP-14 | **Balance-delta reentrancy** | ERC777 or callback token re-enters during transfer | Standard ERC20 (USDC) has no hooks; balance check is defense-in-depth | Slither flagged; accepted |

---

## Coverage Matrix

| Component | Unit Tests | Integration | Fuzz/Invariant | Formal |
|-----------|------------|-------------|----------------|--------|
| Nullifier uniqueness | ✓ | ✓ | ✓ | — |
| Merkle root consistency | ✓ | ✓ | ✓ | — |
| Fee math | ✓ | ✓ | ✓ | ✓ | Halmos |
| Proof verification | ✓ | ✓ | — | — |
| RelayAdapt adaptParams | ✓ | ✓ | — | — |
| CCTP shield/unshield | ✓ | ✓ | — | — |

---

## Gaps and Recommendations

1. **Formal verification:** Proof verification logic (input construction, curve checks) not formally verified. Consider Halmos for nullifier/commitment consistency.
2. **RelayAdapt trust:** Document that users trust the proof system; RelayAdapt cannot steal if proof is valid (user commits to exact calls).
3. **Production:** Remove VERIFICATION_BYPASS, ensure testingMode=false, verify CCTP domain config.
