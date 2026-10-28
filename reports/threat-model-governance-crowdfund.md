# Threat Model: Governance & Crowdfund

**Domain:** ArmadaGovernor, ArmadaToken, ArmadaTreasuryGov, TreasurySteward, ShieldPauseController, RevenueCounter, RevenueLock, RevenueReserveDistributor, ArmadaWindDown, ArmadaRedemption, RedemptionRouter, ArmadaCrowdfund (including its Multicall surface, see `reports/multicall/`)
**Date:** 2026-02-17 (updated 2026-10-28)

> **Status (2026-10-28):** the Launch 1 governance contracts are being abandoned in favour of a new governance system (design TBD), and the crowdfund is winding up. This model covers the deployed Launch 1 contracts and is kept accurate for them, but it won't be extended to the replacement. The privacy pool, yield and fee module are covered by `threat-model-privacy-pool-yield.md`.

---

## Architecture Summary

- **ArmadaGovernor:** Custom UUPS-upgradeable governor with typed proposals (Standard, Extended, VetoRatification, Steward); voting via ERC20Votes delegation; timelock execution; Security Council veto with community ratification.
- **ArmadaToken:** ERC20Votes token (12M fixed supply); delegation-based voting power; transfer-restricted via whitelist until wind-down, or an Extended governance proposal (`setTransferable`), enables free transfers.
- **ArmadaTreasuryGov:** Governance-controlled treasury; direct distributions; aggregate outflow rate limits with rolling windows; steward budget (absolute per-token with rolling window).
- **TreasurySteward:** Minimal steward identity management (election, term, removal). Steward spending flows through `ArmadaGovernor.proposeStewardSpend()` as pass-by-default proposals.
- **ShieldPauseController:** the Security Council shield pause is disabled: `MAX_PAUSE_DURATION = 0` (#589), so an SC pause expires in the block it is made and `emergencyPaused()` is always false. Only the wind-down behaviour remains: after wind-down, shields are paused permanently and the pool is withdraw-only.
- **RevenueCounter:** UUPS-upgradeable cumulative revenue tracking, used by RevenueLock milestones and the ArmadaWindDown revenue threshold. Revenue enters through the permissionless `syncStablecoinRevenue()` (pulls from the configured fee collector; there is no fee module in Launch 1) and through governance `addRevenue` / `attestRevenue` (owner-only, Standard proposals).
- **RevenueReserveDistributor:** irrevocable reserve grants and sponsored batch claims (#529).
- **RevenueLock:** Revenue-gated progressive ARM release for team/airdrop allocations. Six milestones (10k→1M cumulative revenue) unlock 10%→100% of each beneficiary's allocation. Beneficiaries and amounts are immutable after construction.
- **ArmadaWindDown:** Irreversible protocol shutdown. Two triggers: (1) permissionless if deadline passed and cumulative revenue below threshold, (2) governance proposal. Activates ARM transferability, disables governance, puts pool in withdraw-only mode.
- **ArmadaRedemption:** Pro-rata treasury redemption for ARM holders post-wind-down. `redeem(armAmount, tokens[], ethRecipient)` locks ARM for a proportional share of each listed swept asset (multi-asset). Only available `REDEMPTION_DELAY` (14 days) after wind-down activation.
- **RedemptionRouter:** contingency periphery that redeems every swept asset in one call (#256; see Gap 8).
- **ArmadaCrowdfund:** Hop-based whitelist sale; seeds → invite → commit → finalize → claim/refund. Supports off-chain EIP-712 signed invites via `commitWithInvite()`.

---

## Threat Table: Governance

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| G-01 | **Double voting** | Voter casts multiple votes on same proposal | hasVoted[proposalId][voter] check | Governance adversarial |
| G-02 | **Vote after snapshot** | Voter delegates after proposal snapshot to gain power | getPastVotes(snapshotBlock) via ERC20Votes | Integration tests |
| G-03 | **Checkpoint manipulation** | Attacker corrupts checkpoint history | Append-only ERC20Votes checkpoints; overwrite only same block | ArmadaToken tests |
| G-04 | **Reentrancy** | Token callback re-enters delegation | ERC20Votes delegation is internal accounting only (no external calls) | — |
| G-05 | **Quorum bypass** | Proposal passes without quorum | Quorum check in state(); forVotes + againstVotes + abstainVotes; quorum is `max(percentage, QUORUM_FLOOR)` with `QUORUM_FLOOR` = 200,000 ARM (#589) | Governance tests |
| G-06 | **Proposal threshold bypass** | Proposer below the threshold (absolute 5,000 ARM, `PROPOSAL_THRESHOLD`, #249) creates proposal | _checkProposalThreshold at creation | Governance tests |
| G-07 | **Timelock bypass** | Execute without queuing | TimelockController enforces schedule | Integration tests |
| G-08 | **block.timestamp manipulation** | Miner influences vote timing | Document miner influence; standard for governance | — |
| G-09 | **Zero owner (fixed)** | ArmadaTreasuryGov.constructor | Fixed: require(_owner != address(0)) | Governance adversarial |
| G-10 | **Steward budget overflow** | Steward spends beyond configured per-token budget | Rolling window check in stewardSpend + aggregate outflow limit | Governance tests |
| G-11 | **SC key compromise** | Compromised Security Council vetoes legitimate proposals | Community ratification vote overrides veto and ejects SC; new SC requires governance proposal (no self-reinstatement) | GovernorVeto tests |
| G-12 | **SC pause abuse** | SC triggers shield pause to DoS deposits | Not possible: `MAX_PAUSE_DURATION = 0` (#589), so an SC pause expires in the block it is made | ShieldPauseController tests (`test_MAX_PAUSE_DURATION_isZero`) |
| G-13 | **Premature wind-down** | Permissionless wind-down triggered unexpectedly (deadline passed + revenue below threshold) | Governance can extend deadline via Extended proposal; revenue threshold provides safety margin; wind-down is irreversible by design | ArmadaWindDown tests |
| G-14 | **RevenueCounter manipulation** | Inflated cumulative revenue triggers premature RevenueLock (team/airdrop) unlocks | Two paths raise revenue: the fee collector (set by the timelock-only `setFeeCollector`, pulled via permissionless `syncStablecoinRevenue()`), and governance `addRevenue` / `attestRevenue`, which are **Standard** proposals. RevenueLock limits the damage with a per-day ratchet on observed revenue (`MAX_REVENUE_INCREASE_PER_DAY`, $10k/day by default) | RevenueCounter, RevenueLock tests |

---

## Threat Table: Crowdfund

| ID | Threat | Description | Mitigation | Test Coverage |
|----|--------|--------------|------------|---------------|
| C-01 | **Allocation rounding** | Pro-rata creates dust or over-allocates | Integer division; allocUsdc + refund == committed | AllocationFuzz, adversarial |
| C-02 | **Over-allocation** | sum(allocations) > totalAllocated | Hop-level upper bound; per-participant alloc <= reserve share | Invariant tests |
| C-03 | **Double claim** | Participant claims twice | p.claimed check | Integration tests |
| C-04 | **Phase violation** | commit during wrong phase | `require(phase == Phase.Active)` guards; timestamp checks | Adversarial tests |
| C-05 | **Reentrancy** | claim/refund re-entered | ReentrancyGuard | ReentrancyAttacker tests |
| C-06 | **Hop cap bypass** | Commit exceeds the participant's effective cap | Over-cap commits are accepted by design; the cap is applied at finalization (capped demand) and the excess is refunded at settlement | Integration tests |
| C-07 | **Invite graph cycles** | invitee invites inviter | Invite graph is tree; hop = inviter.hop + 1 | — |
| C-08 | **finalize() DoS** | Unbounded loop over participants | O(n participants); hard cap `MAX_FINALIZE_NODES = 1800` enforced in `_initParticipant`, sized for the 2^24 per-tx gas cap | Adversarial tests |
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
2. **finalize() DoS:** Participant count is hard-capped at `MAX_FINALIZE_NODES = 1800`, sized for the 2^24 per-tx gas cap.
3. **block.timestamp:** Miner influence on vote timing documented; acceptable for governance.
4. **Cross-contract:** Crowdfund → ArmadaToken (ERC20Votes) → Governor flow verified (claimed ARM → delegate → vote).
5. **ShieldPauseController fuzz/invariant tests:** moot since #589 disabled the SC pause (`MAX_PAUSE_DURATION = 0`); only the wind-down behaviour remains, covered by `ShieldPauseController.t.sol`.
6. **RevenueCounter fuzz/invariant tests:** No fuzz testing for cumulative fee accounting. An invariant that `cumulativeRevenue` is monotonically non-decreasing would catch accounting bugs.
7. **Wind-down irreversibility:** The wind-down is intentionally irreversible. The governance deadline-extension mechanism is the only defense against premature permissionless triggers. Consider whether the revenue threshold and deadline defaults provide sufficient safety margin for mainnet.
8. **Redeem-before-sweep (issue #254):** `ArmadaRedemption.redeem()` has two layered mitigations:
   - **`anyPayout` guard:** reverts if no requested asset produces a non-zero payout, preventing ARM lock-in with zero return.
   - **`REDEMPTION_DELAY` (14 days):** gates all redemptions until 14 days after `triggerTime`, providing a social-coordination window for sweeps to complete.

   Residual risk: **partial-sweep forfeiture** — if some tokens are swept and others are not when a user redeems, they receive a share of swept assets but forfeit their claim on unswept ones. The unpaid share then flows pro-rata to later redeemers. The 14-day delay mitigates this by giving all sweeps time to complete, but does not guarantee they do. Operational: rely on coordinators/relayers to batch-sweep during the delay window, and frontends to warn if treasury balances remain.

   **Forgotten-token forfeiture (issue #256, accepted residual):** the variant where a token *is* swept and available but the redeemer omits it from `tokens[]`. The redemption succeeds, ARM is locked, and the omitted share is silently and irreversibly forfeited to later redeemers. ETH cannot be forgotten (`ethRecipient` must be non-zero when the pool holds ETH) and listing an unswept token reverts (`zero share for token`), but omitting an available token has no on-chain guard. Decision (2026-07): accept on-chain (no change to the immutable `redeem()` interface) and mitigate operationally:
   - **`RedemptionRouter`** (`contracts/periphery/RedemptionRouter.sol`) — pre-built contingency periphery, deployed only during the 14-day window with the complete swept-token list baked in at construction (`scripts/deploy_redemption_router.ts` builds it from `TokenSwept` events). `redeemAll(armAmount, recipient)` claims every asset in one call, removing the footgun for UI and direct callers alike. Kept compiling and tested in CI (`test-foundry/RedemptionRouter.t.sol`, `test/winddown_redemption_integration.ts`) so it cannot rot before it is needed.
   - **Wind-down runbook** (`docs/winddown-redemption-runbook.md`) — window checklist: sweep everything, deploy + verify the router, publish a signed manifest (router address, complete token list, calldata template for direct callers), monitor `Redeemed` events for incomplete token lists.
   - Any future redemption frontend must enumerate the token list from `TokenSwept` events / the router, never let the user hand-edit `tokens[]`.

   Remaining exposure after mitigations: assets swept *after* a user has redeemed (inherent to sequential pro-rata with permanently locked ARM — addressed only by completing sweeps within the window), and direct callers who ignore the published manifest and router.

9. **Indexer reorg handling:** `CROWDFUND_CONFIRMATION_DEPTH` (default 12) is the stated reorg guarantee — only data at least that many blocks behind the chain head is verified. Reorgs deeper than that are unhandled but acceptable on the Ethereum L1 mainnet hub (chain id 1), where a >12-block reorg implies a consensus/finality failure rather than normal operation. Raw logs are deduped by `(chainId, contract, txHash, logIndex)` — excluding `blockHash` — so a tx re-mined at a new block cannot double-apply (Postgres via its primary key, file store via `getLogDedupeKey`).
