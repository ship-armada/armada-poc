# Static Analysis Summary

**Date:** 2025-02-13  
**Tools:** Slither (completed), Aderyn (skipped — Rust not configured)

---

## Slither Results

**Command:** `slither contracts/ --exclude-dependencies --exclude-informational`  
**Output:** `reports/slither-report.txt`, `reports/slither-report.json`  
**Findings:** 189 across 96 contracts

---

## Triage: High / Medium Findings

### Action Required

| Finding | Contract | Severity | Decision |
|--------|----------|----------|----------|
| **unchecked-transfer** | ArmadaYieldAdapter.lendPrivate | High | **Fixed:** Replaced `shareToken.transfer` with `shareToken.safeTransfer` |
| **arbitrary-send-eth** | PrivacyPoolRelayAdapt._multicall | High | **Accept (by design):** RelayAdapt executes user-specified calls; proof binds the operation. Document trust model. |
| **arbitrary-send-eth** | Treasury.transferETH | Medium | **Review:** Railgun legacy; ensure only owner can call. |
| **controlled-delegatecall** | PrivacyPool._delegatecall | Medium | **Accept:** Module addresses set at init by owner; delegatecall is architectural pattern. |
| **incorrect-return / incorrect-modifier** | Proxy.onlyOwner | Medium | **Review:** Proxy redirects non-owner to delegate; Slither may misread control flow. Verify behavior. |
| **missing-zero-check** | PrivacyPool.initialize | Medium | **Fixed:** Added zero-checks for all address params (modules, tokenMessenger, messageTransmitter, usdc, owner). |
| **missing-zero-check** | ArmadaTreasuryGov.constructor | Medium | **Fixed:** Added `require(_owner != address(0))`. |
| **tx-origin** | PrivacyPool.verify, RelayAdapt | Low | **Accept:** VERIFICATION_BYPASS is test-only; mainnet should not use. |
| **uninitialized-local** | ArmadaCrowdfund.finalize reserves/demands | High | **False positive:** Variables are assigned in loop (L256-257); Slither misses loop assignment. |
| **uninitialized-local** | MerkleModule.insertLeaves nextLevelHashIndex | Medium | **Review:** Check if variable is used before assignment. |

### Accept / False Positive

| Finding | Contract | Decision |
|--------|----------|----------|
| uninitialized-state (PrivacyPoolStorage) | PrivacyPoolStorage | **False positive:** Set in `PrivacyPool.initialize()`. |
| reentrancy-balance (ShieldModule) | ShieldModule._transferTokenIn | **Accept:** Balance-delta check is intentional; ERC20 has no hooks. |
| reentrancy-no-eth (PrivacyPool.initialize) | PrivacyPool | **Accept:** Init is one-time; delegatecall to MerkleModule.initializeMerkle. |
| reentrancy-events | Multiple | **Accept:** CEI-recommended but events-after-call is common; assess per contract. |
| locked-ether (ReentrancyAttacker) | contracts/test/ | **Accept:** Test contracts only. |
| constable-states | PrivacyPoolStorage | **False positive:** State changes at runtime. |
| calls-loop | ShieldModule, TransactModule | **Accept:** Batch operations require loops. |
| timestamp | Governance, Crowdfund | **Accept:** block.timestamp used for phase/voting windows; document miner influence. |

### Defer / Document

| Finding | Contract | Decision |
|--------|----------|----------|
| events-access | MockAaveSpoke, MockUSDCV2 | **Defer:** Mocks; add events if promoted to production. |
| unused-return (approve) | ArmadaYieldAdapter | **Review:** ERC20 approve returns bool; SafeERC20 not used for shareToken in lendPrivate. |
| shadowing-local | ArmadaYieldVault | **Low:** Constructor params shadow ERC20; verify no bug. |

---

## Aderyn

**Status:** Not run.  
**Reason:** `cargo install aderyn` failed — Rust toolchain not configured (`rustup default stable` needed).  
**Action:** Install manually: `rustup default stable && cargo install aderyn`, then run `aderyn .` and append findings to this summary.

---

## Recommended Next Steps

1. ~~**Immediate fixes:**~~ **Done.** ArmadaYieldAdapter.lendPrivate (safeTransfer), PrivacyPool.initialize zero-checks, PrivacyPool.setTreasury zero-check, ArmadaTreasuryGov.constructor zero-check.
2. **Review:** ArmadaCrowdfund.finalize reserves/demands initialization, Proxy.onlyOwner behavior.
3. **Document:** RelayAdapt trust model (arbitrary calls bound by ZK proof).
4. **Optional:** Run Aderyn when Rust is available; triage and merge into this summary.
