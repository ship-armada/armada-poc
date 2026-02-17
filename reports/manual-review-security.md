# Manual Review: Security Checklist

**Date:** 2025-02-17  
**Scope:** Reentrancy, access control, input validation, oracle risk

---

## Reentrancy

| Contract | Status | Notes |
|----------|--------|-------|
| ArmadaCrowdfund | ✅ | `ReentrancyGuard` on `commit`, `finalize`, `claim`, `refund`. CEI in commit (state before transferFrom). |
| ArmadaYieldVault | ✅ | `ReentrancyGuard` on `deposit`, `redeem`. CEI: state updates before external calls (spoke, treasury, receiver). |
| ArmadaYieldAdapter | ✅ | `ReentrancyGuard` on all state-changing functions. `lendAndShield`/`redeemAndShield` call PrivacyPool then vault; pool verifies proof before transfer. |
| VotingLocker | ✅ | `ReentrancyGuard` on `lock`, `unlock`. CEI: checkpoint before transferFrom/transfer. |
| ArmadaGovernor | ✅ | `ReentrancyGuard` on `execute` (timelock call). `castVote` has no external calls. |
| ArmadaTreasuryGov | ✅ | `ReentrancyGuard` on `exerciseClaim`. `distribute`, `stewardSpend` transfer after checks; no callback. |
| PrivacyPool | ✅ | No direct ETH/token transfers; modules use SafeERC20. Delegatecall to modules runs in pool context; modules don't call back into pool mid-flow. |
| ShieldModule | ⚠️ | Slither: reentrancy-balance on `_transferTokenIn`. **Accept:** ERC20 has no hooks; balance-delta check is intentional. |
| TransactModule | ✅ | Nullify-then-transfer pattern; no reentrancy into pool. |

---

## Access Control

| Contract | Role | Mechanism | Notes |
|----------|------|------------|-------|
| ArmadaCrowdfund | admin | `onlyAdmin` | Immutable; set in constructor. |
| ArmadaYieldVault | owner | `onlyOwner` | Transferable. |
| ArmadaYieldAdapter | owner, relayers | `onlyOwner`, `onlyRelayer` | Relayers set by owner. |
| VotingLocker | (none) | — | Permissionless lock/unlock. |
| ArmadaGovernor | (none) | — | Permissionless propose/vote; timelock is executor. |
| ArmadaTreasuryGov | owner (timelock), steward | `onlyOwner`, `onlySteward` | Owner = TimelockController. |
| PrivacyPool | owner | `msg.sender == owner` | Set at init. |
| PrivacyPoolRelayAdapt | — | `adaptContract == msg.sender` | PrivacyPool verifies; relay executes user-bound calls. |

**RelayAdapt:** Slither flags arbitrary-send-eth in `_multicall`. **Accept:** User's ZK proof binds `adaptParams`; relay cannot change calls. Documented in threat model.

---

## Input Validation

| Contract | Check | Status |
|----------|-------|--------|
| ArmadaCrowdfund | Zero address (seeds, invitee, treasury) | ✅ |
| ArmadaCrowdfund | Phase, timing windows | ✅ |
| ArmadaCrowdfund | Hop cap, amount > 0 | ✅ |
| ArmadaYieldVault | Zero spoke, treasury, receiver | ✅ |
| ArmadaYieldAdapter | Zero usdc, vault, recipient | ✅ |
| ArmadaYieldAdapter | adaptContract, adaptParams (lendAndShield) | ✅ |
| VotingLocker | amount > 0, oldBalance >= amount | ✅ |
| ArmadaGovernor | targets.length > 0, support <= 2 | ✅ |
| ArmadaTreasuryGov | Zero beneficiary, amount | ✅ |
| PrivacyPool | All module/owner addresses at init | ✅ (fixed) |
| PrivacyPool | setTreasury zero-check | ✅ (fixed) |
| ShieldModule | Commitment preimage, token validation | ✅ |
| TransactModule | Merkle root, nullifiers, bound params | ✅ |

---

## Oracle / External Risk

| Dependency | Risk | Mitigation |
|------------|------|------------|
| Aave Spoke (MockAaveSpoke) | Malicious or buggy | POC uses mock; production must audit Aave integration. |
| CCTP TokenMessenger | Message forgery | CCTP attestation; verify sender/domain. |
| SNARK Verifier | Wrong verification key | Owner sets keys; testing mode bypass is POC-only. |
| Poseidon | Hash collision | Standard Railgun circuit; audited. |
| block.timestamp | Miner manipulation | Used for phases/voting; ±15s typical; acceptable for POC. |
| block.number | Snapshot timing | `block.number - 1` for proposal threshold; safe. |

---

## Summary

- **Reentrancy:** ReentrancyGuard and CEI used where needed.
- **Access control:** Admin/owner/relayer roles clearly defined; RelayAdapt trust model documented.
- **Input validation:** Zero-checks and bounds applied; Slither fixes applied.
- **Oracle risk:** External deps (Aave, CCTP) noted; testing mode is POC-only.
