# Integration Flows — Phase 6.1

**Date:** 2025-02-17  
**Test run:** 262 Hardhat tests passing, 59 Foundry tests passing

---

## Documented Flows

### 1. Privacy Pool: Shield → Transfer → Unshield

| Step | Test | File |
|------|------|------|
| Batch shield (5 notes) | ✓ | `privacy_pool_hardening.ts` — "Full Lifecycle: batch shield → transact → unshield" |
| Private transfer (1 nullifier, 2 commitments) | ✓ | Same |
| Local unshield to recipient | ✓ | Same |
| Fee accounting (shield fee → treasury) | ✓ | "should correctly account shield fees to treasury" |
| Merkle root history (sequential shields) | ✓ | "Sequential shields preserve merkle root history" |

**Status:** All pass. Uses testing mode (SNARK bypass) for POC.

---

### 2. Privacy Pool: Cross-Chain Round-Trip

| Step | Test | File |
|------|------|------|
| Client shield (CCTP burn) | ✓ | `privacy_pool_hardening.ts` — "Client shield → Hub receive → Hub unshield back to Client" |
| Hub receive (CCTP mint + processIncomingShield) | ✓ | Same |
| Hub unshield via atomicCrossChainUnshield | ✓ | Same |
| Client receive (relay receiveMessage) | ✓ | Same |

**Status:** All pass. Full CCTP flow with MockCCTP.

---

### 3. Yield: Shielded Lend → Withdraw

| Flow | Test | File |
|------|------|------|
| POC lend (direct: user → adapter → vault) | ✓ | `yield_integration.ts` — "should allow lend via adapter" |
| POC redeem (direct) | ✓ | "should allow redeem via adapter" |
| Relayer lendPrivate | ✓ | "should allow relayer to execute private operations" |
| redeemAndUnshield (pay to recipient) | ✓ | "should allow redeemAndUnshield" |
| redeemAndUnshieldCCTP (cross-chain) | ✓ | "should allow redeemAndUnshieldCCTP" |
| Full deposit → yield → redeem | ✓ | "should complete full deposit → yield → redeem flow" |

**Status:** All pass. Relayer flows are trusted-relayer (POC); trustless lendAndShield/redeemAndShield require real SNARK proofs.

---

### 4. Crowdfund → Claim → Lock → Vote

| Step | Test | File |
|------|------|------|
| Add seeds, invite hop-1 | ✓ | `cross_contract_integration.ts` — "full lifecycle" |
| Seeds invite hop-1 | ✓ | Same |
| Commit (80 seeds × $15K) | ✓ | Same |
| Finalize | ✓ | Same |
| Claim ARM | ✓ | Same |
| Lock in VotingLocker | ✓ | Same |
| Propose | ✓ | Same |
| Cast vote | ✓ | Same |
| Queue to timelock | ✓ | Same |
| Execute | ✓ | Same |

**Status:** All pass.

---

## Gaps

| Flow | Gap | Recommendation |
|------|-----|----------------|
| **lendAndShield** | No integration test with real SNARK proof | Requires circuit artifacts; POC uses relay or testing mode. Document as production requirement. |
| **redeemAndShield** | Same | Same. |
| **Privacy pool with production proofs** | All integration tests use testing mode | Mainnet must have testingMode=false and valid verification keys. |
| **Batched crowdfund finalize** | finalize() is O(1) (lazy allocation); claim() is O(1) per participant | No unbounded loop; participantList not iterated in finalize. Documented in TESTING_NEXT_STEPS. |

---

## Test Commands

```bash
npm run test:all          # All Hardhat tests (262)
npm run test:forge        # Foundry tests (59)
npm run test              # privacy_pool_integration only
npm run test:governance   # governance_integration + adversarial
npm run test:crowdfund    # crowdfund_integration + adversarial
```
