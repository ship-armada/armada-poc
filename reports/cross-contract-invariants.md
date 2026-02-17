# Cross-Contract Invariants — Phase 6.2

**Date:** 2025-02-17

---

## Token Balance Consistency

### USDC

| Location | Invariant | Test Coverage |
|----------|-----------|---------------|
| PrivacyPool | `pool USDC balance` = sum of shielded commitments (minus unshields) | Implicit in shield/unshield flows; no explicit balance assertion |
| ArmadaYieldVault | `vault.totalAssets()` = Aave Spoke supplied assets | `YieldInvariant.t.sol`: totalAssets consistency |
| ArmadaYieldAdapter | Adapter holds 0 USDC at rest (POC relay: unshield → deposit → shield) | Integration: lend/redeem flows |
| ArmadaCrowdfund | `usdc.balanceOf(crowdfund)` = totalCommitted - totalProceedsAccrued + proceedsWithdrawnAmount (before claims) | CrowdfundInvariant.t.sol |
| ArmadaTreasuryGov | Holds governance tokens + yield fees | Manual; no invariant test |

### ayUSDC (Vault Shares)

| Location | Invariant | Test Coverage |
|----------|-----------|---------------|
| ArmadaYieldVault | `totalSupply()` × sharePrice ≈ totalAssets (within rounding) | YieldInvariant.t.sol |
| ArmadaYieldAdapter | Adapter holds 0 shares at rest (relay flow) | Integration |
| PrivacyPool | Shielded ayUSDC = commitments in merkle | PrivacyPoolInvariant (MerkleHandler) |

---

## ARM Supply Consistency

| Invariant | Description | Test Coverage |
|-----------|-------------|---------------|
| **Total supply constant** | `armToken.totalSupply()` = 100M (fixed at deploy) | `cross_contract_integration.ts`: "ARM total supply remains 100M after crowdfund distribution" |
| **Crowdfund allocation** | Sum of claimed ARM + unallocated ≤ initial funding | CrowdfundInvariant; withdrawUnallocatedArm |
| **Voting power** | `votingLocker.totalLocked()` ≤ total supply | VotingLockerInvariant |
| **Quorum** | `quorum = (totalSupply - treasuryBalance) * quorumBps / 10000` | `cross_contract_integration.ts`: "quorum calculation remains correct" |

---

## Cross-Domain Invariants

| Invariant | Description | Test Coverage |
|-----------|-------------|---------------|
| **Crowdfund → Governance** | Claimed ARM can be locked and used for voting | Full lifecycle test |
| **Proposal threshold** | 0.1% of total supply; crowdfund participant can reach (pooled) | "proposal threshold is reachable by crowdfund participant" |
| **Snapshot consistency** | Voting power at snapshot block; lock after proposal = no power | "voting power reflects lock state at proposal snapshot" |
| **Double-claim prevention** | Crowdfund claim once; Governor vote once | "double-claim prevention across crowdfund claim and governance vote" |

---

## Gaps

1. **PrivacyPool USDC balance:** No explicit invariant linking merkle commitments to pool balance; relies on correct nullifier/commitment logic.
2. **Treasury balance:** ArmadaTreasuryGov and ArmadaTreasury (yield) hold different tokens; no cross-contract balance invariant.
3. **CCTP cross-chain:** MockCCTP; real CCTP would need attestation and domain validation invariants.
