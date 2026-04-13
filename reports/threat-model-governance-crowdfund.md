# Threat Model: Governance & Crowdfund

**Domain:** ArmadaGovernor, ArmadaToken, ArmadaTreasuryGov, TreasurySteward, ShieldPauseController, RevenueCounter, RevenueLock, ArmadaWindDown, ArmadaRedemption, ArmadaCrowdfund
**Date:** 2025-02-13 (updated 2026-04-13)

---

## Architecture Summary

- **ArmadaGovernor:** Custom UUPS-upgradeable governor with typed proposals (Standard, Extended, VetoRatification, Steward); voting via ERC20Votes delegation; timelock execution; Security Council veto with community ratification.
- **ArmadaToken:** ERC20Votes token (12M fixed supply); delegation-based voting power; transfer-restricted via whitelist until wind-down enables free transfers.
- **ArmadaTreasuryGov:** Governance-controlled treasury; direct distributions; aggregate outflow rate limits with rolling windows; steward budget (absolute per-token with rolling window).
- **TreasurySteward:** Minimal steward identity management (election, term, removal). Steward spending flows through `ArmadaGovernor.proposeStewardSpend()` as pass-by-default proposals.
- **ShieldPauseController:** Security Council can pause shield (deposit) operations for up to 24 hours with auto-expiry. Timelock can unpause early. Post-wind-down: SC gets exactly one 24h pause, then permanently disabled. SC address read from governor (ejection auto-reflected).
- **RevenueCounter:** UUPS-upgradeable cumulative fee tracking. Fee collector (ArmadaFeeModule) reports fees; counter tracks cumulative total used by RevenueLock milestones and ArmadaWindDown revenue threshold.
- **RevenueLock:** Revenue-gated progressive ARM release for team/airdrop allocations. Six milestones (10k→1M cumulative revenue) unlock 10%→100% of each beneficiary's allocation. Beneficiaries and amounts are immutable after construction.
- **ArmadaWindDown:** Irreversible protocol shutdown. Two triggers: (1) permissionless if deadline passed and cumulative revenue below threshold, (2) governance proposal. Activates ARM transferability, disables governance, puts pool in withdraw-only mode.
- **ArmadaRedemption:** Pro-rata treasury redemption for ARM holders post-wind-down. Burn ARM to receive proportional share of treasury USDC. Only available after wind-down activation.
- **ArmadaCrowdfund:** Hop-based whitelist sale; seeds → invite → commit → finalize → claim/refund. Supports off-chain EIP-712 signed invites via `commitWithInvite()`.

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
| G-11 | **SC key compromise** | Compromised Security Council vetoes legitimate proposals | Community ratification vote overrides veto and ejects SC; new SC requires governance proposal (no self-reinstatement) | GovernorVeto tests |
| G-12 | **SC pause abuse** | SC triggers shield pause to DoS deposits for 24h | Auto-expiry after 24h; timelock can unpause early; post-wind-down SC gets exactly one non-renewable pause | ShieldPauseController tests |
| G-13 | **Premature wind-down** | Permissionless wind-down triggered unexpectedly (deadline passed + revenue below threshold) | Governance can extend deadline via Extended proposal; revenue threshold provides safety margin; wind-down is irreversible by design | ArmadaWindDown tests |
| G-14 | **RevenueCounter manipulation** | Compromised fee collector inflates cumulative revenue, triggering premature RevenueLock unlocks | feeCollector address set via timelock-only call; only authorized ArmadaFeeModule can report fees | RevenueCounter tests |

---

## Threat Table: Crowdfund

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| C-01 | **Allocation rounding** | Pro-rata creates dust or over-allocates | Integer division; allocUsdc + refund == committed | AllocationFuzz, adversarial |
| C-02 | **Over-allocation** | sum(allocations) > totalAllocated | Hop-level upper bound; per-participant alloc <= reserve share | Invariant tests |
| C-03 | **Double claim** | Participant claims twice | p.claimed check | Integration tests |
| C-04 | **Phase violation** | commit during wrong phase | `require(phase == Phase.Active)` guards; timestamp checks | Adversarial tests |
| C-05 | **Reentrancy** | claim/refund re-entered | ReentrancyGuard | ReentrancyAttacker tests |
| C-06 | **Hop cap bypass** | Commit exceeds per-hop cap | capUsdc enforced in commit | Integration tests |
| C-07 | **Invite graph cycles** | invitee invites inviter | Invite graph is tree; hop = inviter.hop + 1 | — |
| C-08 | **finalize() DoS** | Unbounded loop over participants | O(n participants); participant count bounded by invite chain limits (~1,500 max); documented in `_iterateCappedDemand()` NatSpec | Adversarial tests |
| C-09 | **Treasury zero address** | withdrawUnallocatedArm() sends ARM to zero address | `require(_treasury != address(0))` in constructor; treasury is immutable | Adversarial tests |
| C-10 | **Elastic expansion edge** | totalCommitted exactly at ELASTIC_TRIGGER | Boundary tests | Adversarial tests |
| C-11 | **Signed invite replay** | EIP-712 signed invite replayed to commit multiple times | Nonce tracking via `usedNonces` mapping; each nonce consumed on first use; `revokeInviteNonce()` for preemptive revocation | EIP-712 tests |

---

## Coverage Matrix

| Component | Unit Tests | Integration | Fuzz/Invariant | Formal |
|-----------|------------|-------------|----------------|--------|
| ArmadaToken (ERC20Votes) | ✓ | ✓ | ✓ | — |
| ArmadaGovernor | ✓ | ✓ | ✓ | — |
| ArmadaTreasuryGov | ✓ | ✓ | ✓ | — |
| TreasurySteward | ✓ | ✓ | ✓ | — |
| ShieldPauseController | ✓ | ✓ | — | — |
| RevenueCounter | ✓ | ✓ | — | — |
| ArmadaCrowdfund allocation | ✓ | ✓ | ✓ | Halmos ✓ |
| Crowdfund phase machine | ✓ | ✓ | ✓ | — |
| Crowdfund EIP-712 invites | ✓ | ✓ | — | — |
| RevenueLock | ✓ | ✓ | ✓ | — |
| ArmadaWindDown | ✓ | ✓ | ✓ | — |
| ArmadaRedemption | ✓ | ✓ | ✓ | — |

---

## Gaps and Recommendations

1. **Halmos:** Formal verification for allocation math added: allocUsdc + refund == committed (all inputs) — verified in HalmosAllocation.t.sol.
2. **finalize() DoS:** Participant count bounded by invite chain limits (~1,500 max). Documented in `_iterateCappedDemand()` NatSpec.
3. **block.timestamp:** Miner influence on vote timing documented; acceptable for governance.
4. **Cross-contract:** Crowdfund → ArmadaToken (ERC20Votes) → Governor flow verified (claimed ARM → delegate → vote).
5. **ShieldPauseController fuzz/invariant tests:** No fuzz or invariant tests for the pause controller. The auto-expiry and one-shot post-wind-down behavior would benefit from invariant testing (e.g., "pause duration never exceeds MAX_PAUSE_DURATION", "post-wind-down pause can only fire once").
6. **RevenueCounter fuzz/invariant tests:** No fuzz testing for cumulative fee accounting. An invariant that `cumulativeRevenue` is monotonically non-decreasing would catch accounting bugs.
7. **Wind-down irreversibility:** The wind-down is intentionally irreversible. The governance deadline-extension mechanism is the only defense against premature permissionless triggers. Consider whether the revenue threshold and deadline defaults provide sufficient safety margin for mainnet.
