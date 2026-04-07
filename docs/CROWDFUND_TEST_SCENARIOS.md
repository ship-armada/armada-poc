# ArmadaCrowdfund — Comprehensive Testing Scenarios

## Purpose

Exhaustive catalog of testing scenarios for ArmadaCrowdfund, organized by lifecycle phase and cross-cutting concern. Each scenario identifies the behavior under test, expected outcome, and current test coverage status. Use this as a checklist when writing or auditing tests.

**Contract under test:** `contracts/crowdfund/ArmadaCrowdfund.sol`
**Interface:** `contracts/crowdfund/IArmadaCrowdfund.sol`

**Phase model:** Active → Finalized | Canceled (3-phase; no separate Setup/Invitation/Commitment phases)
**Role model:** `launchTeam` (seed/invite management) · `securityCouncil` (cancel)
**Timing model:** Single 3-week window (`windowStart` to `windowEnd`); invites and commits happen concurrently during the window.

---

## 1. Constructor & Deployment

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 1.1 | Deploy with valid USDC, ARM, launchTeam, securityCouncil, treasury | Phase.Active, all counters zero, hop configs correct | `crowdfund_integration.ts` |
| 1.2 | Deploy with zero securityCouncil address | Revert | `crowdfund_adversarial.ts` |
| 1.3 | Deploy with zero treasury address | Revert | `crowdfund_adversarial.ts` |
| 1.4 | Deploy with zero launchTeam address | Revert | `crowdfund_launch_team.ts` |
| 1.5 | Verify hop configs: 7000/4500/0 BPS ceilings, $15K/$4K/$1K caps, 3/2/0 maxInvites, 1/10/20 maxInvitesReceived | All values correct | `crowdfund_integration.ts` |
| 1.6 | Verify ELASTIC_TRIGGER = $1,500,000 (1_500_000 * 1e6) | Exact match | `crowdfund_adversarial.ts`, `CrowdfundElasticFuzz.t.sol` |
| 1.7 | Verify HOP2_FLOOR_BPS = 500 (5%) | Correct | Code review |
| 1.8 | Verify reserveBps are valid across all hops | Ceiling BPS valid | `CrowdfundInvariant.t.sol` (INV-C2) |
| 1.9 | Verify launchTeam and securityCouncil are immutable (no setter) | No setter exists | Code review |
| 1.10 | Verify window timestamps: windowEnd = windowStart + 21 days, launchTeamInviteEnd = windowStart + 7 days | Exact match | `crowdfund_integration.ts` |

---

## 2. Active Phase — Seed Management

Seeds are hop-0 participants added by the launch team. Adding seeds requires ARM to be pre-loaded via `loadArm()`.

### ARM Pre-Loading

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 2.1 | `loadArm()` when ARM balance == 0 | Revert | `crowdfund_integration.ts` |
| 2.2 | `loadArm()` when ARM balance < MAX_SALE | Revert | `crowdfund_integration.ts` |
| 2.3 | `loadArm()` when ARM balance >= MAX_SALE | Succeeds, sets armLoaded flag | `crowdfund_integration.ts` |
| 2.4 | `loadArm()` called twice (idempotent) | Second call succeeds (no-op) | `crowdfund_integration.ts` |
| 2.5 | `loadArm()` is permissionless | Any address can call | `crowdfund_integration.ts` |
| 2.6 | `addSeed()` before ARM loaded | Revert | `crowdfund_integration.ts` |

### Seed Addition

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 2.7 | launchTeam adds single seed via `addSeed()` | Participant whitelisted at hop 0, participantCount increments, `SeedAdded` event | `crowdfund_integration.ts` |
| 2.8 | launchTeam batch-adds seeds via `addSeeds()` | All whitelisted at hop 0, counts correct | `crowdfund_integration.ts` |
| 2.9 | Non-launchTeam calls `addSeed()` | Revert | `crowdfund_integration.ts` |
| 2.10 | Add seed with zero address | Revert | `crowdfund_integration.ts` |
| 2.11 | Add duplicate seed | Revert: "already whitelisted" | `crowdfund_integration.ts` |
| 2.12 | Add seeds after week 1 (launchTeamInviteEnd) | Revert | `crowdfund_adversarial.ts`, `crowdfund_launch_team.ts` |
| 2.13 | Allow up to MAX_SEEDS (150) seeds | Succeeds | `crowdfund_launch_team.ts` |
| 2.14 | 151st seed addition | Revert | `crowdfund_launch_team.ts` |
| 2.15 | `addSeeds()` batch that exceeds MAX_SEEDS mid-batch | Revert | `crowdfund_launch_team.ts` |

---

## 3. Active Phase — Invitations

Invitations and commitments happen concurrently during the 3-week active window. Any whitelisted participant can invite downstream addresses.

### Basic Invitation Mechanics

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.1 | Seed invites valid address → hop 1 | Invitee whitelisted at hop 1, invitedBy = seed, `Invited` event | `crowdfund_integration.ts` |
| 3.2 | Hop-1 invites valid address → hop 2 | Invitee whitelisted at hop 2, invitedBy = hop-1 addr | `crowdfund_integration.ts` |
| 3.3 | Hop-2 attempts to invite | Revert: max hop reached (hop-2 maxInvites = 0) | `crowdfund_integration.ts` |
| 3.4 | Invite zero address | Revert | `crowdfund_integration.ts` |
| 3.5 | Non-whitelisted address calls `invite()` | Revert | `crowdfund_integration.ts` |
| 3.6 | Invite after windowEnd | Revert | `crowdfund_integration.ts`, `crowdfund_adversarial.ts` |
| 3.7 | Invite before windowStart | Revert | `crowdfund_adversarial.ts` |

### Invite Limits

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.8 | Seed sends 3 invites (maxInvites for hop-0) | All succeed | `crowdfund_integration.ts` |
| 3.9 | Seed sends 4th invite | Revert: invite limit reached | `crowdfund_integration.ts` |
| 3.10 | Hop-1 sends 2 invites (maxInvites for hop-1) | Both succeed | `crowdfund_integration.ts` |
| 3.11 | Hop-1 sends 3rd invite | Revert: invite limit reached | `crowdfund_integration.ts` |
| 3.12 | `getInvitesRemaining()` decrements correctly | 3→2→1→0 for seed | `crowdfund_integration.ts` |
| 3.13 | `invite()` increments `invitesSent` on inviter's node | Correct | `crowdfund_integration.ts` |

### Invitation Graph Integrity

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 3.14 | Hop assignment: seed = 0, invitee of seed = 1, invitee of hop-1 = 2 | Correct hop values | `crowdfund_integration.ts` |
| 3.15 | `invitedBy` is `address(0)` for seeds | Correct | `crowdfund_integration.ts` |
| 3.16 | `whitelistCount` increments per hop on each invite | Correct | `crowdfund_integration.ts` |
| 3.17 | Multiple seeds inviting distinct addresses — no cross-contamination | Each invitee's hop and invitedBy correct | `crowdfund_multinode.ts` |

---

## 4. Active Phase — EIP-712 Signed Invites

Off-chain signed invitations via `commitWithInvite()` allow gasless invite distribution. The inviter signs an EIP-712 typed struct; the invitee submits the signature along with their USDC commitment in a single transaction.

### EIP-712 Domain & Types

- **Domain:** `name="ArmadaCrowdfund"`, `version="1"`, `chainId`, `verifyingContract`
- **Type hash:** `INVITE_TYPEHASH = keccak256("Invite(address invitee,uint8 fromHop,uint256 nonce,uint256 deadline)")`
- **Nonce tracking:** `usedNonces[inviter][nonce]` — per-inviter, 1-indexed (nonce 0 reserved for direct `invite()`)

### commitWithInvite Scenarios

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.1 | Valid signed invite + commit USDC | Invitee whitelisted, USDC committed, both `Invited` and `Committed` events | `crowdfund_eip712.ts` |
| 4.2 | Expired deadline (block.timestamp > deadline) | Revert | `crowdfund_eip712.ts` |
| 4.3 | Nonce = 0 (reserved) | Revert | `crowdfund_eip712.ts` |
| 4.4 | Replayed nonce (already used) | Revert | `crowdfund_eip712.ts` |
| 4.5 | Revoked nonce | Revert | `crowdfund_eip712.ts` |
| 4.6 | Invalid signature (wrong signer) | Revert | `crowdfund_eip712.ts` |
| 4.7 | Tampered data (signature for different invitee) | Revert | `crowdfund_eip712.ts` |
| 4.8 | Inviter budget exhausted | Revert | `crowdfund_eip712.ts` |
| 4.9 | After window end | Revert | `crowdfund_eip712.ts` |
| 4.10 | fromHop=1 (hop-1 inviter → hop-2 invitee) | Succeeds | `crowdfund_eip712.ts` |
| 4.11 | fromHop=2 (hop-2 cannot invite further) | Revert | `crowdfund_eip712.ts` |
| 4.12 | Caller is launchTeam address | Revert (launchTeam cannot commit) | `crowdfund_eip712.ts` |
| 4.13 | Invitee already at maxInvitesReceived | Revert | `crowdfund_eip712.ts` |

### commitWithInvite Amount Boundaries

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.14 | amount = 0 | Revert | `crowdfund_eip712.ts` |
| 4.15 | amount < MIN_COMMIT ($10) | Revert | `crowdfund_eip712.ts` |
| 4.16 | amount = MIN_COMMIT exactly | Succeeds | `crowdfund_eip712.ts` |

### revokeInviteNonce

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 4.17 | Revoke unused nonce | Succeeds, emits `InviteNonceRevoked` | `crowdfund_eip712.ts` |
| 4.18 | Revoke nonce 0 (reserved) | Revert | `crowdfund_eip712.ts` |
| 4.19 | Revoke already-used nonce | Revert | `crowdfund_eip712.ts` |
| 4.20 | Revoke already-revoked nonce | Revert | `crowdfund_eip712.ts` |

---

## 5. Active Phase — Commitments

Commitments happen concurrently with invitations during the 3-week active window.

### Basic Commitment

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.1 | Whitelisted participant commits valid USDC | p.committed updates, totalCommitted updates, USDC transferred, `Committed` event | `crowdfund_integration.ts` |
| 5.2 | Multiple commits from same address at same hop accumulate | p.committed = sum of commits | `crowdfund_integration.ts` |
| 5.3 | Commit at exact windowStart | Succeeds | `crowdfund_adversarial.ts` |
| 5.4 | Commit after windowEnd | Revert | `crowdfund_adversarial.ts` |

### Over-Cap Acceptance (excess refunded at settlement)

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.5 | Commit up to effective cap | Succeeds, full allocation expected | `crowdfund_adversarial.ts` |
| 5.6 | Commit over effective cap | Succeeds (excess refunded at settlement) | `crowdfund_integration.ts` |
| 5.7 | Commit exactly at cap boundary | Succeeds | `crowdfund_adversarial.ts` |

### Invalid Commits

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.8 | Non-whitelisted address commits | Revert | `crowdfund_integration.ts` |
| 5.9 | Amount below MIN_COMMIT ($10) | Revert | `crowdfund_adversarial.ts` |
| 5.10 | Amount exactly MIN_COMMIT ($10) | Succeeds | `crowdfund_adversarial.ts` |
| 5.11 | launchTeam address attempts to commit | Revert (sentinel cannot commit) | `crowdfund_adversarial.ts`, `crowdfund_launch_team.ts` |

### Aggregate Tracking

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 5.12 | `hopStats[h].totalCommitted` accumulates correctly per hop | Sum matches expected | `crowdfund_integration.ts` |
| 5.13 | `uniqueCommitters` increments on first commit only | First commit: +1, subsequent: no change | `crowdfund_integration.ts`, `crowdfund_multinode.ts` |
| 5.14 | `totalCommitted` equals sum across all hops | Global sum correct | `crowdfund_integration.ts` |
| 5.15 | Contract USDC balance equals `totalCommitted` before finalization | Exact match | `CrowdfundInvariant.t.sol` (INV-C3) |

---

## 6. Finalization

`finalize()` is **permissionless** — anyone can call it after `windowEnd`. It computes allocations, determines sale size, pushes proceeds to treasury, and transitions to Finalized phase.

### Preconditions

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.1 | finalize() after windowEnd (permissionless) | Succeeds | `crowdfund_lifecycle.ts`, `ArmadaCrowdfundRefundMode.t.sol` |
| 6.2 | finalize() before windowEnd | Revert | `crowdfund_adversarial.ts` |
| 6.3 | Double finalization | Revert: already finalized | `crowdfund_integration.ts` |
| 6.4 | finalize() after cancellation | Revert | `crowdfund_settlement.ts` |
| 6.5 | finalize() with cappedDemand < MIN_SALE ($1M) | Sets refundMode = true, transitions to Finalized | `crowdfund_adversarial.ts`, `ArmadaCrowdfundRefundMode.t.sol` |
| 6.6 | finalize() with 0 committers | Revert | `crowdfund_adversarial.ts` |
| 6.7 | Any address (non-launchTeam, non-securityCouncil) can call finalize() | Succeeds | `crowdfund_adversarial.ts` |

### Elastic Expansion

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.8 | cappedDemand < ELASTIC_TRIGGER ($1.5M) → saleSize = BASE_SALE ($1.2M) | BASE_SALE | `crowdfund_adversarial.ts`, `CrowdfundElasticFuzz.t.sol` |
| 6.9 | cappedDemand = ELASTIC_TRIGGER ($1.5M) → saleSize = MAX_SALE ($1.8M) | MAX_SALE | `crowdfund_adversarial.ts`, `CrowdfundElasticFuzz.t.sol` |
| 6.10 | cappedDemand = ELASTIC_TRIGGER - 1 → saleSize = BASE_SALE | BASE_SALE | `CrowdfundElasticFuzz.t.sol` |
| 6.11 | cappedDemand > ELASTIC_TRIGGER → saleSize = MAX_SALE | MAX_SALE | `crowdfund_lifecycle.ts` |
| 6.12 | Elastic trigger uses cappedDemand (not totalCommitted) | Over-cap excess does not inflate trigger | `crowdfund_adversarial.ts`, `CrowdfundElasticFuzz.t.sol` |

### RefundMode

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.13 | Post-allocation total < MIN_SALE triggers refundMode | refundMode = true, no ARM distributed | `ArmadaCrowdfundRefundMode.t.sol` |
| 6.14 | In refundMode: `claim()` reverts | Revert | `ArmadaCrowdfundRefundMode.t.sol` |
| 6.15 | In refundMode: `claimRefund()` returns full committed USDC | Succeeds | `ArmadaCrowdfundRefundMode.t.sol` |
| 6.16 | In refundMode: double `claimRefund()` reverts | Revert | `ArmadaCrowdfundRefundMode.t.sol` |
| 6.17 | In refundMode: `withdrawUnallocatedArm()` returns all ARM | Succeeds | `ArmadaCrowdfundRefundMode.t.sol` |
| 6.18 | Elastic expansion + refundMode cannot co-occur | If cappedDemand >= ELASTIC_TRIGGER, post-alloc always >= MIN_SALE | `ArmadaCrowdfundRefundMode.t.sol` |

### Proceeds Pushed at Finalization

Proceeds are pushed atomically to `treasury` inside `finalize()`. There is no separate `withdrawProceeds()` function.

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.19 | Treasury receives proceeds in same tx as finalize | Correct USDC amount transferred | `crowdfund_settlement.ts` |
| 6.20 | Contract balance after finalize covers all refunds | Balance >= sum of all refund amounts | `crowdfund_settlement.ts` |
| 6.21 | refundMode does NOT push proceeds to treasury | No transfer to treasury | `crowdfund_settlement.ts` |
| 6.22 | Emits `Finalized` event with saleSize, totalArm, totalUsdc, refundMode | Correct fields | `crowdfund_settlement.ts` |

### Rollover Logic

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.23 | Hop-0 under-subscribed — leftover rolls to hop-1 | hop-1 ceiling increases | `crowdfund_adversarial.ts` |
| 6.24 | Hop-1 under-subscribed — leftover rolls to hop-2 | hop-2 allocation increases | `crowdfund_adversarial.ts` |
| 6.25 | Hop-2 under-subscribed — leftover to treasuryLeftoverUsdc | Included in saleSize accounting | `crowdfund_adversarial.ts` |
| 6.26 | Seeds-only sale (no hop-1/2 commits) — enters refundMode if below MIN_SALE | Correct | `crowdfund_adversarial.ts` |
| 6.27 | All hops over-subscribed — pro-rata within each hop | No rollover | `crowdfund_adversarial.ts` |
| 6.28 | Rollover preserves sum-of-parts invariant | totalAllocatedUsdc + treasuryLeftoverUsdc == saleSize | `crowdfund_adversarial.ts` |
| 6.29 | Multi-hop oversubscription | Correct pro-rata per hop | `crowdfund_adversarial.ts` |

### Finalization Output

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 6.30 | `totalAllocated` (ARM) stored correctly | Sum of per-address allocations | `crowdfund_eager_allocation.ts` |
| 6.31 | `totalAllocatedUsdc` stored correctly | Sum of per-address USDC allocations | `crowdfund_eager_allocation.ts` |
| 6.32 | `claimDeadline` set to block.timestamp + 1095 days | Exact match | `crowdfund_settlement.ts` |
| 6.33 | `finalizedAt` set to block.timestamp | Correct | `crowdfund_lifecycle.ts` |
| 6.34 | Phase transitions to Finalized | Correct | `crowdfund_lifecycle.ts` |

---

## 7. Allocation Algorithm

Allocation is computed per-node (address, hop) using `_computeAllocation()`. Each hop has a ceiling (BPS of saleSize) and a floor (HOP2_FLOOR_BPS for hop-2). Oversubscribed hops use pro-rata scaling.

### Under-subscribed Hop

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.1 | demand <= ceiling → full allocation (allocUsdc = min(committed, effectiveCap)) | No refund beyond over-cap excess | `crowdfund_integration.ts` |
| 7.2 | allocArm = allocUsdc * 1e18 / ARM_PRICE | Exact conversion at $1/ARM | `crowdfund_eager_allocation.ts` |

### Over-subscribed Hop

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.3 | demand > ceiling → pro-rata: allocUsdc = min(committed, effectiveCap) * ceiling / demand | Scaled proportionally | `crowdfund_integration.ts`, `crowdfund_adversarial.ts` |
| 7.4 | refundUsdc = committed - allocUsdc | Exact remainder | `crowdfund_integration.ts` |
| 7.5 | allocUsdc + refundUsdc == committed per participant (exact, no dust) | Identity holds | `CrowdfundInvariant.t.sol` (INV-C1) |
| 7.6 | Pro-rata with many participants — rounding dust bounded | At most 1 unit per participant | `crowdfund_adversarial.ts` |

### Conservation Invariants

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 7.7 | USDC conservation: netProceeds + sum(refunds) == totalDeposited | Exact | `crowdfund_eager_allocation.ts`, `crowdfund_settlement.ts` |
| 7.8 | ARM solvency: contract holds enough ARM for all allocations | Balance >= totalAllocated | `crowdfund_eager_allocation.ts` |
| 7.9 | totalAllocatedUsdc + treasuryLeftoverUsdc == saleSize | Exact | `crowdfund_eager_allocation.ts` |

---

## 8. Claims (Finalized Path)

`claim(delegate)` transfers the caller's aggregate ARM allocation across all hops in a single transaction. The `delegate` parameter is emitted for off-chain indexing but does not trigger on-chain delegation.

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 8.1 | Participant claims in Finalized phase | Receives ARM, `ArmClaimed` event | `crowdfund_integration.ts`, `crowdfund_lifecycle.ts` |
| 8.2 | ARM amount matches pre-computed `addressArmAllocation` | Exact match | `crowdfund_eager_allocation.ts` |
| 8.3 | Double claim | Revert: already claimed | `crowdfund_integration.ts`, `crowdfund_multinode.ts` |
| 8.4 | Claim with 0 committed (whitelisted but no commitment) | Revert | `crowdfund_adversarial.ts` |
| 8.5 | Claim by non-participant | Revert | `crowdfund_adversarial.ts` |
| 8.6 | Claim in Canceled phase | Revert | `crowdfund_adversarial.ts` |
| 8.7 | Claim in Active phase | Revert | `crowdfund_adversarial.ts` |
| 8.8 | Claim in refundMode | Revert | `ArmadaCrowdfundRefundMode.t.sol` |
| 8.9 | Claim at exact claimDeadline timestamp | Succeeds | `crowdfund_settlement.ts` |
| 8.10 | Claim at claimDeadline + 1 | Revert | `crowdfund_settlement.ts` |
| 8.11 | `totalArmClaimed` accumulator updates on each claim | Running sum | `crowdfund_settlement.ts` |
| 8.12 | claim() and claimRefund() callable independently in either order | Both succeed | `crowdfund_eager_allocation.ts` |

---

## 9. Refunds (Canceled + RefundMode Paths)

`claimRefund()` supports three eligibility paths. Refunds do not expire.

### Path 1 — Normal post-finalization pro-rata refund

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.1 | claimRefund() after successful finalize — returns pre-computed addressRefundAmount | Correct USDC | `crowdfund_integration.ts`, `crowdfund_eager_allocation.ts` |
| 9.2 | Pro-rata refund amounts match oversubscription math | Consistent with allocation | `crowdfund_adversarial.ts` |

### Path 2 — RefundMode full deposit refund

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.3 | claimRefund() in refundMode — returns full committed amount | All USDC back | `ArmadaCrowdfundRefundMode.t.sol` |

### Path 3 — Security Council cancel

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.4 | claimRefund() after cancel — returns full committed amount | All USDC back | `crowdfund_settlement.ts`, `crowdfund_multinode.ts` |
| 9.5 | cancel() before window opens | Succeeds | `crowdfund_settlement.ts` |
| 9.6 | cancel() during Active window | Succeeds | `crowdfund_settlement.ts` |
| 9.7 | cancel() after window but before finalize | Succeeds | `crowdfund_settlement.ts` |
| 9.8 | cancel() after finalize | Revert | `crowdfund_settlement.ts` |
| 9.9 | cancel() when already canceled | Revert | `crowdfund_settlement.ts` |
| 9.10 | Non-securityCouncil calls cancel() | Revert | `crowdfund_settlement.ts` |
| 9.11 | After cancel: commit reverts | Correct | `crowdfund_settlement.ts` |
| 9.12 | After cancel: finalize reverts | Correct | `crowdfund_settlement.ts` |
| 9.13 | Emits `Cancelled` event | Correct | `crowdfund_settlement.ts` |

### Refund Guards

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 9.14 | claimRefund() during active window | Revert | `ArmadaCrowdfundRefundMode.t.sol` |
| 9.15 | Double refund | Revert | `ArmadaCrowdfundRefundMode.t.sol`, `crowdfund_adversarial.ts` |
| 9.16 | Refund by non-participant (0 committed) | Revert | `crowdfund_settlement.ts` |
| 9.17 | Whitelisted but 0 committed attempts refund | Revert | `crowdfund_settlement.ts` |

---

## 10. Withdrawals — `withdrawUnallocatedArm` Only

There is no `withdrawProceeds()` function. Proceeds are pushed to treasury atomically during `finalize()`. The only withdrawal function is `withdrawUnallocatedArm()`, which is **permissionless**.

### Three Sweep Windows

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 10.1 | Post-finalization (base sale): sweep unsold ARM immediately | Correct amount: balance - (totalAllocated - totalArmClaimed) | `crowdfund_settlement.ts` |
| 10.2 | After some claims: sweep sees reduced armStillOwed | Correct | `crowdfund_settlement.ts` |
| 10.3 | After claim deadline (3 years): sweep all remaining ARM | armStillOwed = 0 | `crowdfund_settlement.ts` |
| 10.4 | After refundMode finalization: sweep all ARM | Nothing owed | `crowdfund_settlement.ts`, `ArmadaCrowdfundRefundMode.t.sol` |
| 10.5 | After cancel: sweep all ARM | Nothing owed | `crowdfund_settlement.ts`, `ArmadaCrowdfundArmRecovery.t.sol` |

### Guards

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 10.6 | withdrawUnallocatedArm() in Active phase | Revert | `crowdfund_adversarial.ts`, `ArmadaCrowdfundArmRecovery.t.sol` |
| 10.7 | Second sweep when nothing new to sweep | Revert | `crowdfund_settlement.ts`, `ArmadaCrowdfundArmRecovery.t.sol` |
| 10.8 | Permissionless: any address can call | Succeeds | `crowdfund_settlement.ts`, `ArmadaCrowdfundArmRecovery.t.sol` |
| 10.9 | Emits `UnallocatedArmWithdrawn` event | Correct | `crowdfund_settlement.ts` |
| 10.10 | Callable multiple times (no idempotency flag) — sweeps only new surplus | Correct | `crowdfund_settlement.ts` |

---

## 11. View Functions

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 11.1 | `getSaleStats()` during each phase | Returns correct totalCommitted, phase, timing | `crowdfund_integration.ts` |
| 11.2 | `isWhitelisted()` for whitelisted vs. non-whitelisted | true / false | `crowdfund_integration.ts` |
| 11.3 | `getCommitment()` for committer | Returns committed amount | `crowdfund_integration.ts` |
| 11.4 | `getInvitesRemaining()` for non-whitelisted | Returns 0 | `crowdfund_integration.ts` |
| 11.5 | `getHopStats()` for valid hop | Correct stats | `crowdfund_integration.ts` |
| 11.6 | `getParticipantCount()` matches participantNodes length | Correct count | `crowdfund_integration.ts`, `crowdfund_multinode.ts` |
| 11.7 | `getEffectiveCap()` returns invitesReceived × capUsdc | Correct scaling | `crowdfund_multinode.ts` |
| 11.8 | `getInvitesReceived()` returns invite count at hop | Correct | `crowdfund_multinode.ts` |
| 11.9 | `getLaunchTeamBudgetRemaining()` tracks hop-1/hop-2 slots | Correct | `crowdfund_launch_team.ts` |

### Graph Privacy

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 11.10 | `getInviteEdge()` during Active phase | Revert: "graph hidden during sale" | `crowdfund_integration.ts` |
| 11.11 | `getInviteEdge()` after Finalized | Returns correct inviter and hop | `crowdfund_integration.ts` |

### Allocation Views

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 11.12 | `getAllocation()` before finalization | Revert | `ArmadaCrowdfundRefundMode.t.sol` |
| 11.13 | `getAllocation()` after finalization | Returns aggregate ARM + refund across all hops | `crowdfund_eager_allocation.ts` |
| 11.14 | `getAllocationAtHop()` after finalization | Returns per-hop ARM + refund | `crowdfund_eager_allocation.ts` |
| 11.15 | `getAllocation()` in refundMode | Revert | `ArmadaCrowdfundRefundMode.t.sol` |

---

## 12. Multi-Node Participation

The same address can participate at multiple hops via self-invitation. Each (address, hop) tuple is a separate `ParticipantNode` with independent state (commitment, allocation, refund, invite budget). Aggregate totals are stored in `addressArmAllocation[addr]` and `addressRefundAmount[addr]` for single-tx claims.

### Self-Invitation

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 12.1 | Seed self-invites to hop-1 | Creates new (addr, hop-1) node | `crowdfund_multinode.ts`, `crowdfund_adversarial.ts` |
| 12.2 | Recursive self-invitation: hop-0 → hop-1 → hop-2 | Three independent nodes | `crowdfund_multinode.ts` |
| 12.3 | Self-loop edges tracked correctly | invitedBy points to same address at lower hop | `crowdfund_multinode.ts` |
| 12.4 | No duplicate participantNodes entry on self-invite | Array length correct | `crowdfund_multinode.ts` |

### Independent Node State

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 12.5 | Per-node caps enforced independently | Each hop has own effectiveCap | `crowdfund_multinode.ts` |
| 12.6 | Per-node invite budgets enforced independently | Each hop has own budget | `crowdfund_multinode.ts` |
| 12.7 | uniqueCommitters tracked per-node | Correct per hop | `crowdfund_multinode.ts` |

### Aggregate Claim & Refund

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 12.8 | `claim()` aggregates ARM from all hops for an address | Single transfer of total | `crowdfund_multinode.ts` |
| 12.9 | Double claim after aggregate claim | Revert | `crowdfund_multinode.ts` |
| 12.10 | `claimRefund()` aggregates refund USDC across all hops | Single transfer of total | `crowdfund_multinode.ts` |
| 12.11 | Aggregate refund on cancel | Full committed across all hops | `crowdfund_multinode.ts` |
| 12.12 | Full recursive self-fill ($33K across all hops) — finalize → claim | Correct total | `crowdfund_multinode.ts` |

---

## 13. Launch Team Mechanics

The `launchTeam` is a sentinel address (immutable, set at construction) that issues predeclared direct invitations during week 1 only. It is NOT a participant — it cannot commit USDC or be re-invited.

### launchTeamInvite

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 13.1 | launchTeam invites address to hop-1 (fromHop=0) | Invitee whitelisted at hop-1 | `crowdfund_launch_team.ts` |
| 13.2 | launchTeam invites address to hop-2 (fromHop=1) | Invitee whitelisted at hop-2 | `crowdfund_launch_team.ts` |
| 13.3 | fromHop >= 2 | Revert | `crowdfund_launch_team.ts` |
| 13.4 | Caller is not launchTeam | Revert | `crowdfund_launch_team.ts` |
| 13.5 | Invitee is zero address | Revert | `crowdfund_launch_team.ts` |
| 13.6 | After week 1 (day 8+) | Revert | `crowdfund_launch_team.ts` |
| 13.7 | At exactly 7-day boundary | Revert (exclusive boundary) | `crowdfund_launch_team.ts` |
| 13.8 | Day 6 (within week 1) | Succeeds | `crowdfund_launch_team.ts` |
| 13.9 | Invite graph shows launchTeam as inviter | Correct edge | `crowdfund_launch_team.ts` |

### Budget

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 13.10 | Exactly 60 hop-1 invites (LAUNCH_TEAM_HOP1_BUDGET) | All succeed | `crowdfund_launch_team.ts` |
| 13.11 | 61st hop-1 invite | Revert | `crowdfund_launch_team.ts` |
| 13.12 | Exactly 60 hop-2 invites (LAUNCH_TEAM_HOP2_BUDGET) | All succeed | `crowdfund_launch_team.ts` |
| 13.13 | 61st hop-2 invite | Revert | `crowdfund_launch_team.ts` |
| 13.14 | `getLaunchTeamBudgetRemaining()` tracks correctly | Decrements after each invite | `crowdfund_launch_team.ts` |

### Re-Invite Behavior via launchTeam

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 13.15 | Re-invite increments invitesReceived | Correct | `crowdfund_launch_team.ts` |
| 13.16 | Re-invite consumes budget | Correct | `crowdfund_launch_team.ts` |
| 13.17 | Re-invite scales effective cap | Correct | `crowdfund_launch_team.ts` |
| 13.18 | Re-invite scales outgoing invite budget | Correct | `crowdfund_launch_team.ts` |
| 13.19 | Re-invite capped at maxInvitesReceived | Revert if already at max | `crowdfund_launch_team.ts` |

### Sentinel Properties

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 13.20 | launchTeam address cannot commit USDC | Revert | `crowdfund_launch_team.ts`, `crowdfund_adversarial.ts` |
| 13.21 | Regular seed invites still work after week 1 | Succeeds (only launchTeam restricted to week 1) | `crowdfund_launch_team.ts` |

---

## 14. Invite Stacking

Re-inviting an already-whitelisted address at the same hop increments `invitesReceived`, which scales both the effective commitment cap and the outgoing invite budget.

### Cap Scaling

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 14.1 | `effectiveCap = invitesReceived × hopConfigs[hop].capUsdc` | Correct | `crowdfund_multinode.ts` |
| 14.2 | Hop-1 invited 5 times: effectiveCap = 5 × $4K = $20K | Correct | `crowdfund_multinode.ts` |
| 14.3 | Commit up to scaled cap | Full allocation (no over-cap refund) | `crowdfund_multinode.ts` |
| 14.4 | Commit exceeding scaled cap | Excess refunded at settlement | `crowdfund_multinode.ts` |

### Budget Scaling

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 14.5 | `maxBudget = invitesReceived × hopConfigs[hop].maxInvites` | Correct | `crowdfund_multinode.ts` |
| 14.6 | Re-invited seed (invitesReceived=2): budget = 2 × 3 = 6 invites | Correct | `crowdfund_multinode.ts` |

### maxInvitesReceived Per Hop

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 14.7 | Hop-0: maxInvitesReceived = 1 (seeds always 1) | Cannot re-invite seeds | `crowdfund_multinode.ts` |
| 14.8 | Hop-1: maxInvitesReceived = 10 | 11th invite reverts | `crowdfund_multinode.ts` |
| 14.9 | Hop-2: maxInvitesReceived = 20 | 21st invite reverts | `crowdfund_multinode.ts` |
| 14.10 | Different hops enforce different caps | Correct | `crowdfund_multinode.ts` |

### Re-Invite Mechanics

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 14.11 | Second invite from different inviter does not revert | Succeeds, increments invitesReceived | `crowdfund_multinode.ts` |
| 14.12 | Re-invite emits `Invited` event | Correct | `crowdfund_multinode.ts` |
| 14.13 | Re-invite preserves original invitedBy | First inviter stored | `crowdfund_multinode.ts` |
| 14.14 | Full stacking flow: invite → re-invite → commit at scaled cap → finalize → claim | Correct end-to-end | `crowdfund_multinode.ts` |

---

## 15. Cross-Cutting: Access Control

Two-role model: `launchTeam` (operational, pre-finalization) and `securityCouncil` (emergency, any time).

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 15.1 | `addSeed()` / `addSeeds()` — onlyLaunchTeam | Non-launchTeam reverts | `crowdfund_integration.ts` |
| 15.2 | `launchTeamInvite()` — onlyLaunchTeam | Non-launchTeam reverts | `crowdfund_launch_team.ts` |
| 15.3 | `cancel()` — onlySecurityCouncil | Non-securityCouncil reverts | `crowdfund_settlement.ts` |
| 15.4 | `finalize()` — permissionless | Any address succeeds | `crowdfund_adversarial.ts` |
| 15.5 | `withdrawUnallocatedArm()` — permissionless | Any address succeeds | `crowdfund_settlement.ts` |
| 15.6 | `invite()`, `commit()`, `claim()`, `claimRefund()` — any qualifying participant | No role check | `crowdfund_integration.ts` |
| 15.7 | launchTeam and securityCouncil are immutable | No setter exists | `crowdfund_settlement.ts`, `crowdfund_launch_team.ts` |

---

## 16. Cross-Cutting: Reentrancy

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 16.1 | `commit()` is nonReentrant | Reentry blocked | `CrowdfundReentrancy.t.sol` |
| 16.2 | `claim()` is nonReentrant | Reentry blocked | `CrowdfundReentrancy.t.sol` |
| 16.3 | `claimRefund()` is nonReentrant | Reentry blocked | `CrowdfundReentrancy.t.sol` |
| 16.4 | `commitWithInvite()` is nonReentrant | Modifier present | Code review |
| 16.5 | CEI pattern in `commit()`: state updated before `safeTransferFrom` | Verified | Code review |
| 16.6 | CEI pattern in `claim()`: `armClaimed = true` before transfer | Verified | Code review |
| 16.7 | CEI pattern in `claimRefund()`: `refundClaimed = true` before transfer | Verified | Code review |

---

## 17. Cross-Cutting: Token Interaction Edge Cases

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 17.1 | External USDC sent directly to contract (not via commit) | Does not change accounting (totalCommitted unchanged) | `CrowdfundDonation.t.sol` |
| 17.2 | External ARM sent directly to contract | Increases unallocated ARM; captured by `withdrawUnallocatedArm()` | `CrowdfundDonation.t.sol` |
| 17.3 | Donated USDC does not enable premature sweep | Correct | `CrowdfundDonation.t.sol` |
| 17.4 | Donated ARM does not affect allocation math | Correct | `CrowdfundDonation.t.sol` |
| 17.5 | ARM_PRICE = 1e6 ensures no division-by-zero | Always safe | Code review |

---

## 18. Cross-Cutting: State Machine Integrity

Three-phase model: **Active → Finalized | Canceled**. Phase only moves forward; there is no Setup, Invitation, or Commitment sub-phase.

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 18.1 | Phase only moves forward: Active → Finalized or Active → Canceled | Never regresses | `CrowdfundInvariant.t.sol`, `CrowdfundFullInvariant.t.sol` |
| 18.2 | All state-mutating functions have appropriate phase guards | Verified per function | `crowdfund_integration.ts`, `crowdfund_adversarial.ts` |
| 18.3 | After Finalized: only claim, claimRefund, withdrawUnallocatedArm, emitSettlement, and views work | All other mutations revert | `crowdfund_settlement.ts` |
| 18.4 | After Canceled: only claimRefund, withdrawUnallocatedArm, and views work | All other mutations revert | `crowdfund_settlement.ts` |

---

## 19. Settlement Modes

Finalization supports two modes: single-TX (default) and phased (for gas-constrained large participant lists).

### Single-TX Mode

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 19.1 | `finalize()` emits `Allocated` and `AllocatedHop` events inline | Correct events | `crowdfund_eager_allocation.ts` |
| 19.2 | Stored allocations readable immediately after finalize() | Correct | `crowdfund_eager_allocation.ts` |
| 19.3 | Per-hop `Participant.allocation` set at finalization | Correct | `crowdfund_eager_allocation.ts` |
| 19.4 | `emitSettlement()` reverts in single-TX mode | Correct | `crowdfund_eager_allocation.ts` |
| 19.5 | `AllocatedHop` only emitted when armAmount > 0 | Correct | `crowdfund_eager_allocation.ts` |
| 19.6 | Settlement invariant: sum(AllocatedHop) == Allocated.totalArmAmount per address | Correct | `crowdfund_eager_allocation.ts` |

### Phased Mode

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 19.7 | finalize() stores allocations but does NOT emit settlement events | Correct | `crowdfund_eager_allocation.ts` |
| 19.8 | `emitSettlement()` emits events in batches | Correct | `crowdfund_eager_allocation.ts` |
| 19.9 | `emitSettlement()` reverts with non-sequential startIndex | Correct | `crowdfund_eager_allocation.ts` |
| 19.10 | `emitSettlement()` reverts after settlement complete | Correct | `crowdfund_eager_allocation.ts` |
| 19.11 | `claim()` available immediately after finalize() (before emitSettlement) | Correct | `crowdfund_eager_allocation.ts` |
| 19.12 | `emitSettlement()` reverts in refundMode | Correct | `crowdfund_eager_allocation.ts` |

### Mode Equivalence

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 19.13 | Phased and single-TX modes produce identical allocations | Verified | `crowdfund_eager_allocation.ts` |

---

## 20. End-to-End Flows

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 20.1 | Happy path: deploy → loadArm → seeds → invite → commit → finalize → claim | Full lifecycle, balances reconcile | `crowdfund_lifecycle.ts` (Path 1) |
| 20.2 | Elastic expansion: enough demand triggers MAX_SALE | saleSize = $1.8M | `crowdfund_lifecycle.ts` (Path 2) |
| 20.3 | RefundMode: post-allocation below MIN_SALE | All USDC refundable, no ARM | `crowdfund_lifecycle.ts` (Path 3) |
| 20.4 | Security Council cancel → full refunds | All USDC back, ARM recoverable | `crowdfund_lifecycle.ts` (Path 4) |
| 20.5 | Below-minimum finalization: window ends, MIN_SALE not met, finalize sets refundMode | claimRefund works after finalize | `crowdfund_lifecycle.ts` (Path 5) |
| 20.6 | Phased settlement: large participant set | Batched event emission | `crowdfund_lifecycle.ts` (Path 6) |
| 20.7 | Mixed hops: seeds + hop-1 + hop-2 all commit, finalize, claim | Each hop allocated per ceiling/demand | `crowdfund_adversarial.ts` |
| 20.8 | Over-subscribed: every participant gets allocUsdc + refundUsdc == committed | Sum-of-parts verified | `crowdfund_adversarial.ts` |
| 20.9 | Full drain: all claims + withdrawUnallocatedArm → contract balance ≈ 0 | At most dust remaining | `crowdfund_settlement.ts` |

---

## 21. Governance Integration (Post-Crowdfund)

| # | Scenario | Expected Outcome | Coverage |
|---|----------|-----------------|----------|
| 21.1 | Claim ARM → self-delegate → voting power granted | Full chain works | `crowdfund_integration.ts` |
| 21.2 | Unclaimed participant cannot delegate (has 0 ARM) | Delegation succeeds but voting power is 0 | Cross-contract integration |

---

## 22. Design Notes & Known Quirks

| # | Finding | Status |
|---|---------|--------|
| 22.1 | launchTeam is a sentinel — cannot commit, not tracked as a participant node | By design |
| 22.2 | `invitedBy` stores only the first inviter; re-invites do not update it | By design |
| 22.3 | Nonce 0 is reserved for direct `invite()` calls — `commitWithInvite` requires nonce > 0 | By design |
| 22.4 | Rounding buffer of 1 USDC per participant retained in contract at finalization | Prevents under-funded refunds |
| 22.5 | `emitSettlement()` exists only for phased mode — gas optimization for large participant sets | By design |
| 22.6 | `delegate` parameter in `claim(delegate)` is emitted for off-chain indexing only — no on-chain delegation | By design |
| 22.7 | No constructor validation on USDC/ARM addresses — deploying with zero/wrong addresses creates unrecoverable contract | Deploy checklist item |

---

## Coverage Summary

| Category | Scenarios | Covered | Source |
|----------|-----------|---------|--------|
| Constructor & Deployment | 10 | 10 | Integration, Adversarial, Launch Team, Foundry |
| Seed Management | 9 | 9 | Integration, Launch Team |
| Invitations | 17 | 17 | Integration, Multinode |
| EIP-712 Signed Invites | 21 | 21 | EIP-712 |
| Commitments | 16 | 16 | Integration, Adversarial, Foundry |
| Finalization | 34 | 34 | Lifecycle, Adversarial, Settlement, RefundMode, Elastic Fuzz |
| Allocation Algorithm | 9 | 9 | Integration, Adversarial, Eager Allocation, Foundry |
| Claims | 12 | 12 | Integration, Lifecycle, Eager Allocation, Settlement, RefundMode |
| Refunds | 18 | 18 | Settlement, RefundMode, Multinode, Adversarial |
| Withdrawals | 10 | 10 | Settlement, Adversarial, ARM Recovery, RefundMode |
| View Functions | 15 | 15 | Integration, Multinode, Launch Team, RefundMode, Eager Allocation |
| Multi-Node | 12 | 12 | Multinode |
| Launch Team | 21 | 21 | Launch Team |
| Invite Stacking | 14 | 14 | Multinode |
| Access Control | 9 | 9 | Integration, Adversarial, Settlement, Launch Team |
| Reentrancy | 7 | 4 | Foundry (CrowdfundReentrancy.t.sol), Code review |
| Token Interactions | 5 | 4 | Foundry (CrowdfundDonation.t.sol), Code review |
| State Machine | 4 | 4 | Foundry (Invariant), Integration, Adversarial, Settlement |
| Settlement Modes | 13 | 13 | Eager Allocation |
| End-to-End Flows | 9 | 9 | Lifecycle, Adversarial, Settlement |
| Governance Integration | 2 | 2 | Integration |
| **Totals** | **~257** | **~253** | |

### Test File Reference

**Hardhat / Mocha (test/):**
- `crowdfund_integration.ts` — Core lifecycle: seeds, invites, commits, finalization, claims
- `crowdfund_lifecycle.ts` — Six lifecycle paths: base, elastic, refundMode, cancel, deadline, phased
- `crowdfund_adversarial.ts` — Boundary conditions, access control, precision, rollover edge cases
- `crowdfund_settlement.ts` — Cancel paths, proceeds push, claim deadline, ARM sweep windows
- `crowdfund_eager_allocation.ts` — Single-TX vs phased settlement, conservation invariants
- `crowdfund_multinode.ts` — Self-invitation, invite stacking, aggregate claims, per-hop caps
- `crowdfund_launch_team.ts` — 150-seed cap, week-1 budget, re-invite, sentinel properties
- `crowdfund_eip712.ts` — Signed invites, nonce tracking, revocation, amount boundaries

**Foundry (test-foundry/):**
- `CrowdfundInvariant.t.sol` — Ceiling BPS, USDC covers commitments, hop cap, alloc+refund=committed, phase monotonicity
- `CrowdfundFullInvariant.t.sol` — Same invariants with full handler coverage
- `CrowdfundReentrancy.t.sol` — Reentrancy tests for claim, claimRefund, commit
- `CrowdfundDonation.t.sol` — Direct token transfers do not affect accounting
- `CrowdfundElasticFuzz.t.sol` — Elastic expansion boundary and fuzz tests
- `ArmadaCrowdfundRefundMode.t.sol` — RefundMode triggers, claims, sweeps
- `ArmadaCrowdfundArmRecovery.t.sol` — ARM recovery after cancel, fuzz
