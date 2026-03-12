# Aderyn Static Analysis Triage

**Date:** 2026-03-11
**Tool:** Aderyn v0.1.9
**Scope:** `contracts/` (excluding test-foundry, node_modules, lib)
**Result:** 9 High, 15 Low — **0 new critical/high findings requiring immediate action**

---

## High Findings Triage

### H-1: `abi.encodePacked()` with dynamic types in hash function
**Instances:** 2 (TransactModule.sol lines 54, 142)
**Verdict: False positive.** Both instances use `abi.encodePacked` to concatenate a string literal prefix with an error reason for `require`. This is string building, not hash collision risk. No security impact.

### H-2: Arbitrary `from` passed to `transferFrom`
**Instances:** 3 (RailgunLogic.sol lines 270, 279, 296)
**Verdict: Not actionable — Railgun internal code.** These are in `contracts/railgun/logic/` which is adapted Railgun code that must not be modified (breaks ZK circuit compatibility). The `msg.sender` is used as `from`, which is the standard pattern. False positive.

### H-3: Unprotected initializer
**Instances:** 4
**Verdict: Already mitigated.**
- `PrivacyPool.initialize()` and `PrivacyPoolClient.initialize()` — Protected by deployer-only guard (H-5 fix). Aderyn doesn't recognize this custom pattern.
- `ArmadaGovernor._initProposal()` — Internal function, not externally callable.
- `IMerkleModule.initializeMerkle()` — Only callable via delegatecall from PrivacyPool during initialize (guarded by `onlyDelegatecall` + `initialized` check).

### H-4: Unsafe Casting (uint256 -> uint120)
**Instances:** 4 (ShieldModule.sol:106, RailgunLogic.sol:179, ArmadaYieldAdapter.sol:219,300)
**Verdict: Known, tracked as M-14 in audit.** The uint120 type is inherited from Railgun's commitment format. Values are bounded by USDC amounts (max ~2^64) so truncation is practically impossible. Already tracked in ROADMAP.md Appendix (M-14). No immediate action.

### H-5: Uninitialized State Variables
**Instances:** 12
**Verdict: False positive.** All are counters/nonces (`nextReserveId`, `nextNonce`, `proposalCount`, etc.) that intentionally start at 0. Solidity zero-initializes all state variables. Some are in test/mock contracts. No security impact.

### H-6: Yul block contains `return`
**Instances:** 1 (Proxy.sol:86)
**Verdict: Not actionable — Railgun internal code.** This is the standard delegatecall proxy pattern where `return` is intentionally used to forward return data. Modifying this would break the proxy.

### H-7: Sending native ETH not protected
**Instances:** 4 (Faucet.sol:32,41, Delegator.sol:108, Treasury.sol:41)
**Verdict: By design.**
- Faucet: Intentionally permissionless (local/testnet only).
- Delegator/Treasury: Protected by `onlyOwner` / `onlyRole` — Aderyn missed these.

### H-8: Return value of function call not checked
**Instances:** 15
**Verdict: False positive.** Most are `_delegatecall()` calls in PrivacyPool that revert internally on failure (the function bubbles up reverts). Others are Aave spoke calls (`spoke.supply`, `spoke.withdraw`) that also revert on failure. The return values are void operations. No security impact.

### H-9: Contract locks Ether without withdraw
**Instances:** 6
**Verdict: Mostly false positive / by design.**
- `ArmadaGovernor`: Has `receive()` to accept ETH for timelock proposals. Locked ETH can be retrieved via governance proposal. Acceptable.
- `ArmadaTreasury`: Has `receive()` and `distribute()` for ETH. Working as designed.
- `Proxy.sol`: Standard proxy pattern with `payable` fallback.
- `ReentrancyAttacker*`: Test contracts only. Not deployed to production.

---

## Low Findings Summary

| ID | Finding | Verdict |
|----|---------|---------|
| L-1 | Centralization risk (onlyOwner) | Known. Pool owner behind timelock is tracked as H-11 in ROADMAP. |
| L-2 | Deprecated `safeApprove` | Known, tracked as M-1 in ROADMAP (TransactModule). PrivacyPoolClient already does reset-then-approve. |
| L-3 | Unsafe ERC20 ops | Mixed: Railgun code (not modifiable), test contracts, and adapter `approve` calls that are safe for known tokens. |
| L-4 | Wide solidity pragma | Intentional — `^0.8.17` is the project standard for all contracts. |
| L-5 | Missing address(0) checks | Most already have checks. Some are in Railgun code (not modifiable). |
| L-6 | `public` could be `external` | Gas optimization only, not security. |
| L-7 | Use constants for literals | Style preference, not security. |
| L-8 | Events missing `indexed` | Style preference. May add for production. |
| L-9 | `nonReentrant` modifier ordering | Our `nonReentrant` is already the only modifier on the guarded functions. |
| L-10 | Modifiers used once | Style preference, not security. |
| L-11 | Empty blocks | Intentional fallback/receive functions. |
| L-12 | Large literals | Style preference. |
| L-13 | Internal functions called once | Intentional for readability. |
| L-14 | TODOs in code | Known — project is actively transitioning from POC. |
| L-15 | Require in loops | Intentional — validation must occur per-item. |

---

## Conclusion

**No new critical or high findings that require immediate remediation.** All Aderyn "High" findings are either:
1. False positives (Aderyn doesn't understand the custom patterns used)
2. In Railgun internal code (must not be modified)
3. Already tracked in the existing audit/ROADMAP

The L-2 finding (deprecated `safeApprove` in TransactModule) reinforces the existing M-1 item in the ROADMAP — this should be addressed but is not blocking.
