# Threat Model: Governance & Crowdfund

**Domain:** ArmadaGovernor, ArmadaToken, ArmadaTreasuryGov, TreasurySteward, ArmadaCrowdfund
**Date:** 2025-02-13 (updated 2026-04-08)

---

## Architecture Summary

- **ArmadaGovernor:** Custom UUPS-upgradeable governor with typed proposals (Standard, Extended, Steward, StewardElection, VetoRatification); voting via ERC20Votes delegation; timelock execution; Security Council veto with community ratification.
- **ArmadaToken:** ERC20Votes token (12M fixed supply); delegation-based voting power; transfer-restricted until wind-down.
- **ArmadaTreasuryGov:** Governance-controlled treasury; direct distributions; aggregate outflow rate limits with rolling windows; steward budget (absolute per-token with rolling window).
- **TreasurySteward:** Minimal steward identity management (election, term, removal). Steward spending flows through `ArmadaGovernor.proposeStewardSpend()` as pass-by-default proposals.
- **ArmadaCrowdfund:** Hop-based whitelist sale; seeds → invite → commit → finalize → claim/refund.

---

## Threat Table: Governance

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| G-01 | **Double voting** | Voter casts multiple votes on same proposal | hasVoted[proposalId][voter] check | Governance adversarial |
| G-02 | **Vote after snapshot** | Voter delegates after proposal snapshot to gain power | getPastVotes(snapshotBlock) via ERC20Votes | Integration tests |
| G-03 | **Checkpoint manipulation** | Attacker corrupts checkpoint history | Append-only ERC20Votes checkpoints; overwrite only same block | ArmadaToken tests |
| G-04 | **Reentrancy** | Token callback re-enters delegation | ERC20Votes delegation is internal accounting only (no external calls) | — |
| G-05 | **Quorum bypass** | Proposal passes without quorum | Quorum check in state(); forVotes + againstVotes + abstainVotes | Governance tests |
| G-06 | **Proposal threshold bypass** | Proposer below 0.1% creates proposal | _checkProposalThreshold at creation | Governance tests |
| G-07 | **Timelock bypass** | Execute without queuing | TimelockController enforces schedule | Integration tests |
| G-08 | **block.timestamp manipulation** | Miner influences vote timing | Document miner influence; standard for governance | — |
| G-09 | **Zero owner (fixed)** | ArmadaTreasuryGov.constructor | Fixed: require(_owner != address(0)) | Governance adversarial |
| G-10 | **Steward budget overflow** | Steward spends beyond configured per-token budget | Rolling window check in stewardSpend + aggregate outflow limit | Governance tests |

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
| ArmadaToken (ERC20Votes) | ✓ | ✓ | ✓ | — |
| ArmadaGovernor | ✓ | ✓ | ✓ | — |
| ArmadaTreasuryGov | ✓ | ✓ | ✓ | — |
| TreasurySteward | ✓ | ✓ | ✓ | — |
| ArmadaCrowdfund allocation | ✓ | ✓ | ✓ | Halmos ✓ |
| Crowdfund phase machine | ✓ | ✓ | ✓ | — |
| RevenueLock | ✓ | — | ✓ | — |
| ArmadaWindDown | ✓ | — | ✓ | — |
| ArmadaRedemption | ✓ | — | ✓ | — |

---

## Gaps and Recommendations

1. **Halmos:** Formal verification for allocation math added: allocUsdc + refund == committed (all inputs) — verified in HalmosAllocation.t.sol.
2. **finalize() DoS:** Participant count bounded by invite chain limits (~1,500 max). Documented in _iterateCappedDemand() NatSpec.
3. **block.timestamp:** Miner influence on vote timing documented; acceptable for governance.
4. **Cross-contract:** Crowdfund → ArmadaToken (ERC20Votes) → Governor flow verified (claimed ARM → delegate → vote).
