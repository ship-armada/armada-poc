# ArmadaCrowdfund — Comprehensive Testing Scenarios

## Purpose

Exhaustive catalog of testing scenarios for ArmadaCrowdfund, organized by lifecycle phase and cross-cutting concern. Each scenario identifies the behavior under test, expected outcome, and current test coverage status. Use this as a checklist when writing or auditing tests.

**Contract under test:** `contracts/crowdfund/ArmadaCrowdfund.sol`
**Interface:** `contracts/crowdfund/IArmadaCrowdfund.sol`

---

## 1. Constructor & Deployment

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 1.1 | Deploy with valid USDC, ARM, admin | Phase.Setup, all counters zero, hop configs correct | Integration |
| 1.2 | Deploy with zero admin address | Revert: "zero admin" | Adversarial |
| 1.3 | Deploy with zero USDC address | Should succeed (no guard exists) — **potential gap** | **None** |
| 1.4 | Deploy with zero ARM token address | Should succeed (no guard exists) — **potential gap** | **None** |
| 1.5 | Verify hop configs match spec (7000/2500/500 BPS, $15K/$4K/$1K caps, 3/2/0 invites) | All values correct | Integration |
| 1.6 | Verify ELASTIC_TRIGGER = 1.5 × BASE_SALE | ELASTIC_TRIGGER == $1,800,000 | **None** |
| 1.7 | Verify reserveBps sum to 10000 across all hops | Sum == 10000 | Foundry INV-C2 |
| 1.8 | Verify admin is immutable (no ownership transfer function) | No setter exists | Code review |

---

## 2. Setup Phase

### Seed Management

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 2.1 | Admin adds single seed via `addSeed()` | Participant whitelisted at hop 0, participantCount increments | Integration |
| 2.2 | Admin batch-adds seeds via `addSeeds()` | All whitelisted at hop 0, counts correct | Integration |
| 2.3 | Non-admin calls `addSeed()` | Revert: "not admin" | Integration |
| 2.4 | Non-admin calls `addSeeds()` | Revert: "not admin" | **None** |
| 2.5 | Add seed with zero address | Revert: "zero address" | Integration |
| 2.6 | Add duplicate seed (same address twice) | Revert: "already whitelisted" | Integration |
| 2.7 | `addSeeds()` with empty array | Succeeds (no-op, no revert) | **None** |
| 2.8 | `addSeeds()` with mixed valid/duplicate entries | Reverts mid-array on the duplicate (all-or-nothing within tx) | **None** |
| 2.9 | Add seeds after `startInvitations()` | Revert: "wrong phase" | Integration |
| 2.10 | Add seed in Finalized phase | Revert: "wrong phase" | **None** |
| 2.11 | Add seed in Canceled phase | Revert: "wrong phase" | **None** |
| 2.12 | Verify `SeedAdded` event emitted per seed | Event with correct indexed address | **None** |

### Starting Invitations

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 2.13 | Start invitations with >= 1 seed | Phase → Invitation, timing windows set correctly | Integration |
| 2.14 | Start invitations with zero seeds | Revert: "no seeds" | Integration |
| 2.15 | Non-admin calls `startInvitations()` | Revert: "not admin" | **None** |
| 2.16 | Call `startInvitations()` twice | First succeeds, second reverts: "wrong phase" | **None** |
| 2.17 | Verify timing: `invitationEnd = invitationStart + 14 days` | Exact match | **None** |
| 2.18 | Verify timing: `commitmentStart = invitationEnd` (no gap, no overlap) | Exact match | **None** |
| 2.19 | Verify timing: `commitmentEnd = commitmentStart + 7 days` | Exact match | **None** |
| 2.20 | Verify `InvitationStarted` event emitted with correct timestamps | Correct invitationEnd, commitmentStart, commitmentEnd | **None** |

---

## 3. Invitation Phase

### Basic Invitation Mechanics

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.1 | Seed invites valid address → hop 1 | Invitee whitelisted at hop 1, invitedBy = seed | Integration |
| 3.2 | Hop-1 invites valid address → hop 2 | Invitee whitelisted at hop 2, invitedBy = hop-1 addr | Integration |
| 3.3 | Hop-2 attempts to invite | Revert: "max hop reached" (hop 2 is NUM_HOPS-1) | Integration |
| 3.4 | Invite at exact `invitationStart` timestamp | Succeeds (>= check) | **None** |
| 3.5 | Invite at exact `invitationEnd` timestamp | Succeeds (<= check) | **None** |
| 3.6 | Invite at `invitationEnd + 1` | Revert: "not invitation window" | Integration |
| 3.7 | Invite before `invitationStart` (if possible to manipulate) | Revert: "not invitation window" | **None** |

### Invite Limits

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.8 | Seed sends 3 invites (max for hop 0) | All succeed | Integration |
| 3.9 | Seed sends 4th invite | Revert: "invite limit reached" | Integration |
| 3.10 | Hop-1 sends 2 invites (max for hop 1) | Both succeed | Integration |
| 3.11 | Hop-1 sends 3rd invite | Revert: "invite limit reached" | Integration |
| 3.12 | Hop-2 sends any invite (maxInvites = 0) | Revert: "max hop reached" (checked before invite limit) | Integration |
| 3.13 | `getInvitesRemaining()` decrements correctly after each invite | 3→2→1→0 for seed | Integration |

### Invalid Invitations

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.14 | Invite already-whitelisted address (another seed) | Revert: "already whitelisted" | Integration |
| 3.15 | Invite self (seed invites own address) | Revert: "already whitelisted" | Adversarial |
| 3.16 | Non-whitelisted address calls `invite()` | Revert: "not whitelisted" | Integration |
| 3.17 | Invite `address(0)` | Revert: "zero address" | **None** |
| 3.18 | Invite the admin/deployer address (non-whitelisted) | Succeeds (admin is not whitelisted by default) | **None** |
| 3.19 | Invite a contract address | Succeeds (no EOA check) | **None** |
| 3.20 | Invite during Setup phase (before `startInvitations()`) | Revert: "not invitation window" (invitationStart = 0, timestamp > 0) | **None** |
| 3.21 | Invite during Commitment window | Revert: "not invitation window" | Adversarial |
| 3.22 | Invite during Finalized phase | Revert: "not invitation window" | **None** |

### Invitation Graph Integrity

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.23 | Verify hop assignment: seed = 0, invitee of seed = 1, invitee of hop-1 = 2 | Correct hop values | Integration |
| 3.24 | Verify `invitedBy` is `address(0)` for seeds | Correct | Integration |
| 3.25 | Verify `invitedBy` points to actual inviter for hop-1 and hop-2 | Correct | **None** |
| 3.26 | Verify `whitelistCount` increments per hop on each invite | Correct per hop | Integration |
| 3.27 | Verify `Invited` event emitted with correct inviter, invitee, hop | Correct event fields | **None** |
| 3.28 | Multiple seeds inviting distinct addresses — no cross-contamination | Each invitee's hop and invitedBy correct | **None** |

---

## 4. Commitment Phase

### Basic Commitment

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.1 | Whitelisted seed commits valid USDC amount | p.committed updates, totalCommitted updates, USDC transferred | Integration |
| 4.2 | Multiple commits from same address accumulate | p.committed = sum of commits | Integration |
| 4.3 | Multiple commits reaching exactly cap | Last commit brings total to cap exactly | Adversarial |
| 4.4 | Commit at exact `commitmentStart` timestamp | Succeeds (>= check) | **None** |
| 4.5 | Commit at exact `commitmentEnd` timestamp | Succeeds (<= check) | **None** |
| 4.6 | Commit at `commitmentEnd + 1` | Revert: "not commitment window" | **None** |
| 4.7 | Commit at `commitmentStart - 1` (during invitation window) | Revert: "not commitment window" | Integration |

### Cap Enforcement

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.8 | Hop-0: commit exactly $15,000 | Succeeds | Adversarial |
| 4.9 | Hop-0: commit $15,001 | Revert: "exceeds hop cap" | Integration |
| 4.10 | Hop-0: commit $10K then $5,001 (cumulative over cap) | Revert: "exceeds hop cap" | **None** |
| 4.11 | Hop-1: commit exactly $4,000 | Succeeds | **None** |
| 4.12 | Hop-1: commit $4,001 | Revert: "exceeds hop cap" | Integration |
| 4.13 | Hop-2: commit exactly $1,000 | Succeeds | **None** |
| 4.14 | Hop-2: commit $1,001 | Revert: "exceeds hop cap" | Integration |
| 4.15 | Commit 1 wei over cap (after prior commits) | Revert: "exceeds hop cap" | Adversarial |

### Invalid Commits

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.16 | Non-whitelisted address commits | Revert: "not whitelisted" | Integration |
| 4.17 | Zero amount commit | Revert: "zero amount" | Integration |
| 4.18 | Commit with insufficient USDC balance (approved but not held) | Revert from SafeERC20 transferFrom | **None** |
| 4.19 | Commit with no USDC approval | Revert from SafeERC20 transferFrom | **None** |
| 4.20 | Commit with partial approval (approve < amount) | Revert from SafeERC20 transferFrom | **None** |
| 4.21 | Commit during Setup phase | Revert: "not commitment window" | **None** |
| 4.22 | Commit during Finalized phase | Revert: "not commitment window" | **None** |
| 4.23 | Commit during Canceled phase | Revert: "not commitment window" | **None** |

### Aggregate Tracking

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.24 | `hopStats[h].totalCommitted` accumulates correctly per hop | Sum matches expected | Integration |
| 4.25 | `uniqueCommitters` increments on first commit, not subsequent | First commit: +1, second commit same addr: no change | Integration |
| 4.26 | `totalCommitted` equals sum across all hops | Global sum correct | Integration |
| 4.27 | Contract USDC balance equals `totalCommitted` before finalization | Exact match | Foundry INV-C3 |
| 4.28 | Verify `Committed` event with correct participant, amount, total, hop | Correct event fields | **None** |

### Minimum Commit Amount

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.29 | Commit 1 wei USDC (smallest possible) | Succeeds (only zero is rejected) | Adversarial |
| 4.30 | Commit 1 wei, then finalize and check allocation rounding | Allocation math doesn't overflow/underflow on tiny amounts | **None** |

---

## 5. Finalization

### Preconditions

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.1 | Finalize after commitmentEnd by admin | Succeeds | Integration |
| 5.2 | Finalize at exactly `commitmentEnd` (not past) | Revert: "commitment not ended" (> check, not >=) | **None** |
| 5.3 | Finalize at `commitmentEnd + 1` | Succeeds | **None** |
| 5.4 | Finalize before commitmentEnd | Revert: "commitment not ended" | Integration |
| 5.5 | Non-admin calls `finalize()` | Revert: "not admin" | Adversarial |
| 5.6 | Double finalization (after successful finalize) | Revert: "already finalized" | Integration |
| 5.7 | Finalize after cancellation | Revert: "already finalized" (same guard) | **None** |
| 5.8 | Finalize during Setup phase (commitmentEnd = 0, timestamp > 0) | Succeeds if `block.timestamp > 0` and phase is not Finalized/Canceled... but phase guard only checks Invitation\|Commitment. **Interesting edge: if phase is Setup, the phase check passes (it's neither Finalized nor Canceled), and timestamp > 0 > commitmentEnd(0). Behavior: would attempt finalization from Setup phase.** | **None — potential bug** |

### Cancellation Path

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.9 | totalCommitted < MIN_SALE ($1M) | Phase → Canceled | Integration |
| 5.10 | totalCommitted = 0 (no commits) | Phase → Canceled | Adversarial |
| 5.11 | totalCommitted exactly MIN_SALE | Phase → Finalized (>= check in elastic, >= MIN_SALE means not <) | Adversarial |
| 5.12 | totalCommitted = MIN_SALE - 1 wei | Phase → Canceled | Adversarial |
| 5.13 | Verify `SaleCanceled` event with totalCommitted amount | Correct event | **None** |

### Elastic Expansion

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.14 | totalCommitted < ELASTIC_TRIGGER → saleSize = BASE_SALE ($1.2M) | BASE_SALE | Adversarial |
| 5.15 | totalCommitted = ELASTIC_TRIGGER ($1.8M) → saleSize = MAX_SALE | MAX_SALE | Adversarial |
| 5.16 | totalCommitted = ELASTIC_TRIGGER - 1 wei → saleSize = BASE_SALE | BASE_SALE | Adversarial |
| 5.17 | totalCommitted > ELASTIC_TRIGGER → saleSize = MAX_SALE | MAX_SALE | **None** |
| 5.18 | Verify ELASTIC_TRIGGER = (BASE_SALE * 15) / 10 with no rounding error | Exact match to MAX_SALE | **None** |

### ARM Balance Check

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.19 | Contract has sufficient ARM for saleSize | Finalization proceeds | Integration |
| 5.20 | Contract has 0 ARM | Revert: "insufficient ARM" | Integration |
| 5.21 | Contract has ARM between BASE_SALE and MAX_SALE worth, with totalCommitted triggering elastic | Revert: "insufficient ARM" (needs MAX_SALE worth) | **None** |
| 5.22 | Contract has exactly required ARM (no excess) | Succeeds with 0 unallocated | **None** |

### Rollover Logic

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.23 | All hops over-subscribed — no rollover | Each hop gets exactly its base reserve (pro-rata within) | Adversarial (partial) |
| 5.24 | Hop-0 under-subscribed, hop-1 uniqueCommitters >= 30 → rollover to hop-1 | hop-1 finalReserve increases by leftover | **None — structurally hard to test with current constants (see 5.31)** |
| 5.25 | Hop-0 under-subscribed, hop-1 uniqueCommitters < 30 → treasury leftover | Leftover in SaleFinalized event | **None — see 5.31** |
| 5.26 | Hop-1 under-subscribed (possibly with rollover from hop-0), hop-2 >= 50 committers → rollover to hop-2 | hop-2 finalReserve increases | **None** |
| 5.27 | Hop-1 under-subscribed, hop-2 uniqueCommitters < 50 → treasury leftover | Leftover in event | **None** |
| 5.28 | Hop-2 under-subscribed → leftover always goes to treasury | treasuryLeftover includes hop-2 excess | **None** |
| 5.29 | Cascading rollover: hop-0 → hop-1 → hop-2 | Reserves augmented sequentially | **None** |
| 5.30 | Seeds-only sale (no hop-1/hop-2 commitments) — rollover behavior | hop-1/2 have 0 committers < thresholds → all excess to treasury | Adversarial |
| 5.31 | **Structural impossibility note:** With current constants, hop-0 under-subscribed + MIN_SALE requires enough hop-1/2 demand that rollover thresholds are likely met. Document which rollover paths are reachable vs. unreachable. | N/A — test design constraint | Adversarial (documented) |

### Finalization Output

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.32 | `finalReserves[h]` and `finalDemands[h]` stored correctly per hop | Match expected values from reserve + rollover math | **None** |
| 5.33 | `totalAllocated` (ARM) is hop-level upper bound | sum of min(demand, reserve) * 1e18 / ARM_PRICE per hop | Integration |
| 5.34 | `totalAllocatedUsdc` is hop-level upper bound | sum of min(demand, reserve) per hop | Integration |
| 5.35 | Verify `SaleFinalized` event fields: saleSize, totalAllocUsdc, totalAllocArm, treasuryLeftoverUsdc | All correct | **None** |
| 5.36 | Phase.Commitment enum value is never written to `phase` storage | Observable quirk — phase goes Invitation → Finalized/Canceled | **None** |

---

## 6. Allocation Algorithm (`_computeAllocation`)

### Under-subscribed Hop

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.1 | demand <= reserve → full allocation (allocUsdc = committed) | No refund, full ARM | Integration (indirectly) |
| 6.2 | allocArm = committed * 1e18 / ARM_PRICE | Exact conversion at $1/ARM | **None** |
| 6.3 | refundUsdc = 0 | No USDC returned | **None** |

### Over-subscribed Hop

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.4 | demand > reserve → pro-rata: allocUsdc = committed * reserve / demand | Scaled down proportionally | Integration |
| 6.5 | allocArm uses multiply-before-divide to avoid precision loss | committed * reserve * 1e18 / (demand * ARM_PRICE) | **None** |
| 6.6 | refundUsdc = committed - allocUsdc | Exact remainder | Integration (invariant) |
| 6.7 | allocUsdc + refundUsdc == committed (exact, no dust) | Per-participant identity | Foundry INV-C1 |
| 6.8 | sum(individual allocArm) <= totalAllocated (hop upper bound) | Difference is at most uniqueCommitters per oversubscribed hop | Adversarial |

### Precision Edge Cases

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.9 | Pro-rata with 1 wei committed, large demand | allocUsdc rounds to 0, refund = 1 wei | **None** |
| 6.10 | Pro-rata with prime number committed amounts (indivisible) | Integer truncation handled correctly | **None** |
| 6.11 | Pro-rata where reserve/demand creates repeating decimal | Truncation toward zero, no overflow | Adversarial (70 seeds, implicitly) |
| 6.12 | Dust accumulation: difference between hop-level totalAllocatedUsdc and sum(individual allocUsdc) | At most `uniqueCommitters` units of dust per oversubscribed hop | Adversarial |
| 6.13 | `_computeAllocation` with committed = 0 | Returns (0, 0, 0) — no revert | **None** |

---

## 7. Claims (Finalized Path)

### Basic Claim

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.1 | Participant claims in Finalized phase | Receives ARM + USDC refund, `claimed` flag set | Integration |
| 7.2 | Claim with oversubscribed hop — partial refund | ARM < committed value, refund > 0 | Integration |
| 7.3 | Claim with under-subscribed hop — full allocation | ARM = committed value, refund = 0 | **None** |
| 7.4 | ARM balance before/after matches allocation | armAfter - armBefore == allocArm | Integration |
| 7.5 | USDC balance before/after matches refund | usdcAfter - usdcBefore == refundUsdc | **None** |
| 7.6 | Verify `Claimed` event with correct armAmount and usdcRefund | Correct event fields | **None** |

### Claim Guards

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.7 | Claim in Canceled phase | Revert: "not finalized" | Adversarial |
| 7.8 | Claim in Setup phase | Revert: "not finalized" | **None** |
| 7.9 | Claim in Invitation/Commitment phase | Revert: "not finalized" | **None** |
| 7.10 | Double claim | Revert: "already claimed" | Integration |
| 7.11 | Claim with 0 committed (whitelisted but no commitment) | Revert: "no commitment" | Adversarial |
| 7.12 | Claim by non-participant (never whitelisted) | Revert: "no commitment" (committed = 0) | Adversarial |
| 7.13 | Claim order doesn't affect individual allocation | First claimer and last claimer get same rate | **None** |

### Accumulator Updates

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.14 | `totalProceedsAccrued` increases by allocUsdc on each claim | Running sum matches | Integration (indirectly) |
| 7.15 | `totalArmClaimed` increases by allocArm on each claim | Running sum matches | **None** |
| 7.16 | After all claims: totalArmClaimed <= totalAllocated | Upper bound holds | Adversarial |
| 7.17 | `p.allocation` and `p.refund` stored correctly after claim (for record-keeping) | Match computed values from `getAllocation()` | **None** |

---

## 8. Refunds (Canceled Path)

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 8.1 | Refund in Canceled phase — full USDC returned | usdcAfter - usdcBefore == p.committed | Integration |
| 8.2 | Refund in Finalized phase | Revert: "not canceled" | Adversarial |
| 8.3 | Refund in non-terminal phase | Revert: "not canceled" | **None** |
| 8.4 | Double refund | Revert: "already refunded" (same `claimed` flag) | Adversarial |
| 8.5 | Refund with 0 committed | Revert: "no commitment" | **None** |
| 8.6 | Refund by non-participant | Revert: "no commitment" | **None** |
| 8.7 | Verify `Refunded` event with correct participant and amount | Correct event fields | **None** |
| 8.8 | All participants refund — contract USDC balance returns to 0 | Exact balance reconciliation | **None** |
| 8.9 | Refund does not transfer any ARM | ARM balance unchanged | **None** |

---

## 9. Admin Withdrawals

### `withdrawProceeds`

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.1 | Withdraw proceeds after all participants claim | Full proceeds transferred | Integration |
| 9.2 | Withdraw proceeds before any claims | Revert: "no proceeds" (totalProceedsAccrued = 0) | **None** |
| 9.3 | Incremental withdrawal: some claim → withdraw → more claim → withdraw again | Each withdrawal gets delta since last | **None** |
| 9.4 | Withdraw all proceeds, then call again | Revert: "no proceeds" | Adversarial |
| 9.5 | Non-admin calls `withdrawProceeds` | Revert: "not admin" | Adversarial |
| 9.6 | Withdraw to zero address | Revert: "zero address" | Adversarial |
| 9.7 | Withdraw proceeds in Canceled phase | Revert: "not finalized" | **None** |
| 9.8 | Withdraw proceeds in non-terminal phase | Revert: "not finalized" | **None** |
| 9.9 | Verify `ProceedsWithdrawn` event with correct treasury and amount | Correct event fields | **None** |

### `withdrawUnallocatedArm`

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.10 | Withdraw unallocated ARM after finalization | Correct amount = balance - (totalAllocated - totalArmClaimed) | Integration |
| 9.11 | Withdraw before any claims (maximum unallocated = funding - totalAllocated) | Reserves enough for all future claims | **None** |
| 9.12 | Withdraw after all claims (unallocated = balance, since armStillOwed = 0 due to rounding) | Returns remaining balance (includes per-participant rounding dust) | **None** |
| 9.13 | Double withdrawal | Revert: "already withdrawn" | Adversarial |
| 9.14 | Non-admin calls `withdrawUnallocatedArm` | Revert: "not admin" | **None** |
| 9.15 | Withdraw to zero address | Revert: "zero address" | **None** |
| 9.16 | Withdraw in Canceled phase | Revert: "not finalized" | **None** |
| 9.17 | Verify `UnallocatedArmWithdrawn` event emitted even if unallocated == 0 | Event emitted with amount = 0 | **None** |
| 9.18 | After `withdrawUnallocatedArm`, remaining ARM >= armStillOwed (all claimants can still claim) | Contract solvency maintained | **None** |

---

## 10. View Functions

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 10.1 | `getSaleStats()` during each phase | Returns correct totalCommitted, phase, timing | Integration |
| 10.2 | `isWhitelisted()` for whitelisted vs. non-whitelisted | true / false | Integration |
| 10.3 | `getCommitment()` for committer | Returns committed amount and hop | Integration |
| 10.4 | `getCommitment()` for non-participant | Returns (0, 0) — no revert | **None** |
| 10.5 | `getInvitesRemaining()` for non-whitelisted | Returns 0 | **None** |
| 10.6 | `getInvitesRemaining()` for hop-2 (maxInvites = 0) | Returns 0 | **None** |
| 10.7 | `getHopStats()` for valid hop (0, 1, 2) | Correct stats | Integration |
| 10.8 | `getHopStats()` for invalid hop (>= 3) | Revert: "invalid hop" | **None** |
| 10.9 | `getParticipantCount()` matches participantList length | Correct count | Integration |

### Graph Privacy

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 10.10 | `getInviteEdge()` during Setup phase | Revert: "graph hidden during sale" | **None** |
| 10.11 | `getInviteEdge()` during Invitation phase | Revert: "graph hidden during sale" | Integration |
| 10.12 | `getInviteEdge()` during Commitment window | Revert: "graph hidden during sale" | **None** |
| 10.13 | `getInviteEdge()` after Finalized | Returns correct inviter and hop | Integration |
| 10.14 | `getInviteEdge()` after Canceled | Returns correct inviter and hop | **None** |
| 10.15 | `getInviteEdge()` for seed — invitedBy = address(0) | Correct | Integration |
| 10.16 | `getInviteEdge()` for non-participant | Returns (address(0), 0) — no revert, but data is default | **None** |

### Allocation Views

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 10.17 | `getAllocation()` before finalization | Revert: "not finalized" | **None** |
| 10.18 | `getAllocation()` after finalization, before claim | Computes on-the-fly, claimed = false | Integration |
| 10.19 | `getAllocation()` after claim | Returns stored p.allocation / p.refund, claimed = true | **None** |
| 10.20 | `getAllocation()` for non-participant | Returns (0, 0, false) — no revert | **None** |
| 10.21 | `getAllocation()` returns same values regardless of when called (stable after finalization) | Deterministic | **None** |

---

## 11. Cross-Cutting: Access Control

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 11.1 | Admin is immutable — no setter, no transfer | Verified by inspection | Code review |
| 11.2 | Every admin-only function rejects non-admin | All 6 functions tested | Partial |
| 11.3 | Participant functions (invite, commit, claim, refund) open to any qualifying address | No admin check on these | Integration |
| 11.4 | View functions callable by anyone in any phase (except graph privacy) | No access restrictions | Integration |

---

## 12. Cross-Cutting: Reentrancy

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 12.1 | `commit()` is nonReentrant | Confirmed by modifier | Adversarial |
| 12.2 | `claim()` is nonReentrant | Confirmed by modifier | Adversarial |
| 12.3 | `refund()` is nonReentrant | Confirmed by modifier | Adversarial |
| 12.4 | `finalize()` is nonReentrant | Confirmed by modifier | Code review |
| 12.5 | `withdrawProceeds()` is NOT nonReentrant (but uses SafeERC20 + no callback surface) | Acceptable — no reentrancy vector via SafeERC20 | Code review |
| 12.6 | `withdrawUnallocatedArm()` is NOT nonReentrant (same reasoning) | Acceptable | Code review |
| 12.7 | CEI pattern in `commit()`: state updated before `safeTransferFrom` | Verified in source | Code review |
| 12.8 | CEI pattern in `claim()`: `claimed = true` before transfers | Verified in source | Code review |
| 12.9 | CEI pattern in `refund()`: `claimed = true` before transfer | Verified in source | Code review |

---

## 13. Cross-Cutting: Token Interaction Edge Cases

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 13.1 | External entity sends USDC directly to contract (not via commit) | Inflates balance; doesn't affect accounting (totalCommitted unchanged) | **None** |
| 13.2 | External entity sends ARM directly to contract | Increases unallocated ARM; `withdrawUnallocatedArm` captures excess | **None** |
| 13.3 | USDC `safeTransferFrom` reverts (e.g., blocklisted address on real USDC) | commit() reverts cleanly | **None** |
| 13.4 | ARM `safeTransfer` reverts (e.g., paused token) | claim() reverts, participant can retry later | **None** |
| 13.5 | ARM_PRICE = 1e6 ensures no division-by-zero in allocation math | Always safe | Code review |

---

## 14. Cross-Cutting: State Machine Integrity

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 14.1 | Phase only moves forward: Setup → Invitation → Finalized\|Canceled | Never regresses | Foundry invariant |
| 14.2 | Phase.Commitment enum value is never written to storage | Observable quirk — contract goes Invitation → Finalized/Canceled | **None** |
| 14.3 | All state-mutating functions have appropriate phase guards | Verified per function | Integration + Adversarial |
| 14.4 | No function can move phase backward | Verified by inspection | Code review |
| 14.5 | After Finalized: only claim, withdrawProceeds, withdrawUnallocatedArm, and views work | All other mutations revert | **None** |
| 14.6 | After Canceled: only refund and views work | All other mutations revert | **None** |

---

## 15. End-to-End Flows

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 15.1 | Happy path: setup → seeds → invite → commit → finalize → claim → withdraw | Full lifecycle, all balances reconcile | Integration |
| 15.2 | Cancellation path: setup → seeds → commit (insufficient) → finalize(cancel) → refund | Full refunds, no ARM distributed | Integration |
| 15.3 | Mixed hops: seeds + hop-1 + hop-2 all commit, finalize, claim | Each hop allocated correctly per its reserve | Adversarial |
| 15.4 | Elastic expansion: 120+ seeds at $15K → saleSize = MAX_SALE | Requires >120 signers (Hardhat default is 20) — tested in adversarial with 200 signers config | Adversarial |
| 15.5 | Over-subscribed with refund: every participant gets allocUsdc + refundUsdc == committed | Sum-of-parts verified | Adversarial |
| 15.6 | Full drain: all claims + withdrawProceeds + withdrawUnallocatedArm → contract balance ≈ 0 | At most dust remaining | Adversarial |

---

## 16. Governance Integration (Post-Crowdfund)

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 16.1 | Claim ARM → lock in VotingLocker → voting power granted | Full chain works | Integration |
| 16.2 | Unclaimed participant cannot lock (has 0 ARM) | Lock of 0 reverts or is meaningless | Cross-contract integration |
| 16.3 | ARM from crowdfund can be transferred to third party before locking | Standard ERC20 behavior | **None** |

---

## 17. Potential Bugs & Design Questions to Investigate

These scenarios arose from code review and may represent actual bugs or known-acceptable behavior that should be explicitly tested and documented.

| # | Finding | Risk | Status |
|---|---------|------|--------|
| 17.1 | **`finalize()` callable from Setup phase if `commitmentEnd` is 0:** The guard `block.timestamp > commitmentEnd` passes when `commitmentEnd = 0` (not yet set). The phase guard checks `phase == Invitation \|\| phase == Commitment`, so Setup would fail. **Actually safe** — the phase guard rejects it. | Low | Safe (phase guard covers it) |
| 17.2 | **`Phase.Commitment` never set:** The enum exists but is never written. `finalize()` checks for it in the phase guard (`phase == Phase.Invitation \|\| phase == Phase.Commitment`), meaning the Commitment check is dead code. | Info | Known quirk |
| 17.3 | **No constructor validation on USDC/ARM addresses:** Deploying with zero or wrong token addresses would create a broken contract with no recovery mechanism. | Medium | Document in deploy checklist |
| 17.4 | **`withdrawProceeds` and `withdrawUnallocatedArm` lack `nonReentrant`:** Both use SafeERC20 and don't have callback surfaces, but adding the modifier would be belt-and-suspenders. | Low | Acceptable for POC |
| 17.5 | **No emergency stop / pause mechanism:** If a bug is discovered post-deployment, there's no way to pause claims. | Medium | Tracked in POC shortcuts |
| 17.6 | **No admin recovery of accidentally-sent tokens:** If someone sends a random ERC20 to the contract, it's stuck forever. | Low | Acceptable |
| 17.7 | **Rollover thresholds (30 hop-1, 50 hop-2) may be structurally unreachable** given the sale minimums and per-hop caps. Test which rollover paths are actually exercisable. | Info | Documented in adversarial tests |

---

## Coverage Summary

| Category | Covered | Gaps | Total |
|----------|---------|------|-------|
| Constructor & Deployment | 3 | 5 | 8 |
| Setup Phase | 7 | 13 | 20 |
| Invitation Phase | 14 | 14 | 28 |
| Commitment Phase | 12 | 18 | 30 |
| Finalization | 12 | 24 | 36 |
| Allocation Algorithm | 4 | 9 | 13 |
| Claims | 6 | 11 | 17 |
| Refunds | 4 | 5 | 9 |
| Admin Withdrawals | 6 | 13 | 19 |
| View Functions | 7 | 14 | 21 |
| Access Control | 2 | 2 | 4 |
| Reentrancy | 3 | 6 | 9 |
| Token Interactions | 0 | 5 | 5 |
| State Machine | 2 | 4 | 6 |
| End-to-End | 4 | 2 | 6 |
| Governance Integration | 1 | 2 | 3 |
| **Totals** | **~87** | **~147** | **~234** |

Many gaps are event emission checks, timestamp boundary tests, and view function edge cases — lower severity but important for completeness. The high-value gaps are in rollover logic (5.24–5.29), incremental admin withdrawals (9.2–9.3), and the allocation precision edge cases (6.9–6.13).
