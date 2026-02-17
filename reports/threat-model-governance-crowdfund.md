# Threat Model: Governance & Crowdfund

**Domain:** ArmadaGovernor, VotingLocker, ArmadaTreasuryGov, TreasurySteward, ArmadaCrowdfund  
**Date:** 2025-02-13

---

## Architecture Summary

- **ArmadaGovernor:** Custom governor with typed proposals (ParameterChange, Treasury, StewardElection); voting via locked tokens; timelock execution.
- **VotingLocker:** ERC20Votes-style checkpointing; lock ARM for voting power; snapshot at proposal creation.
- **ArmadaTreasuryGov:** Governance-controlled treasury; direct distributions, claims, steward budget (1% monthly).
- **TreasurySteward:** Elected steward; proposes actions; veto window; term-limited.
- **ArmadaCrowdfund:** Hop-based whitelist sale; seeds → invite → commit → finalize → claim/refund.

---

## Threat Table: Governance

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| G-01 | **Double voting** | Voter casts multiple votes on same proposal | hasVoted[proposalId][voter] check | Governance adversarial |
| G-02 | **Vote after snapshot** | Voter locks after proposal snapshot to gain power | getPastLockedBalance(snapshotBlock) | Integration tests |
| G-03 | **Checkpoint manipulation** | Attacker corrupts checkpoint history | Append-only; overwrite only same block | VotingLockerInvariant |
| G-04 | **Reentrancy** | Token callback re-enters lock/unlock | ReentrancyGuard on lock/unlock | ReentrancyAttacker tests |
| G-05 | **Quorum bypass** | Proposal passes without quorum | Quorum check in state(); forVotes + againstVotes + abstainVotes | Governance tests |
| G-06 | **Proposal threshold bypass** | Proposer below 0.1% creates proposal | _checkProposalThreshold at creation | Governance tests |
| G-07 | **Timelock bypass** | Execute without queuing | TimelockController enforces schedule | Integration tests |
| G-08 | **block.timestamp manipulation** | Miner influences vote timing | Document miner influence; standard for governance | — |
| G-09 | **Zero owner (fixed)** | ArmadaTreasuryGov.constructor | Fixed: require(_owner != address(0)) | Governance adversarial |
| G-10 | **Steward budget overflow** | Steward spends > 1% monthly | Budget check in stewardSpend | Governance tests |

---

## Threat Table: Crowdfund

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| C-01 | **Allocation rounding** | Pro-rata creates dust or over-allocates | Integer division; allocUsdc + refund == committed | AllocationFuzz, adversarial |
| C-02 | **Over-allocation** | sum(allocations) > totalAllocated | Hop-level upper bound; per-participant alloc <= reserve share | Invariant tests |
| C-03 | **Double claim** | Participant claims twice | p.claimed check | Integration tests |
| C-04 | **Phase violation** | commit during wrong phase | inPhase modifier; timestamp checks | Adversarial tests |
| C-05 | **Reentrancy** | claim/refund re-entered | ReentrancyGuard | ReentrancyAttacker tests |
| C-06 | **Hop cap bypass** | Commit exceeds per-hop cap | capUsdc enforced in commit | Integration tests |
| C-07 | **Invite graph cycles** | invitee invites inviter | Invite graph is tree; hop = inviter.hop + 1 | — |
| C-08 | **finalize() DoS** | Unbounded loop over participants | O(n participants); gas limit; consider batching for production | TESTING_NEXT_STEPS.md |
| C-09 | **Admin withdraw to zero** | withdrawProceeds(0) | require(treasury != address(0)) | Adversarial tests |
| C-10 | **Elastic expansion edge** | totalCommitted exactly at ELASTIC_TRIGGER | Boundary tests | Adversarial tests |

---

## Coverage Matrix

| Component | Unit Tests | Integration | Fuzz/Invariant | Formal |
|-----------|------------|-------------|----------------|--------|
| VotingLocker | ✓ | ✓ | ✓ | — |
| ArmadaGovernor | ✓ | ✓ | — | — |
| ArmadaTreasuryGov | ✓ | ✓ | — | — |
| TreasurySteward | ✓ | ✓ | — | — |
| ArmadaCrowdfund allocation | ✓ | ✓ | ✓ | Halmos candidate |
| Crowdfund phase machine | ✓ | ✓ | ✓ | — |

---

## Gaps and Recommendations

1. **Halmos:** Add formal verification for allocation math: allocUsdc + refund == committed (all inputs).
2. **finalize() DoS:** Document that participant count should be bounded; consider batched finalization for production.
3. **block.timestamp:** Document miner influence on vote timing; acceptable for governance.
4. **Cross-contract:** Verify crowdfund → VotingLocker → Governor flow (claimed ARM → lock → vote).
