# Governance Test Scenarios & Edge Cases

Comprehensive test plan for the Armada governance system covering ArmadaToken (ERC20Votes),
ArmadaGovernor, ArmadaTreasuryGov, and TreasurySteward contracts.

Scenarios marked with issue numbers (e.g., #19) reference known bugs filed on Codeberg.

---

## Proposal Type Timing Reference

| Type | Voting Delay | Voting Period | Execution Delay | Total Lifecycle | Quorum | Notes |
|------|-------------|---------------|-----------------|-----------------|--------|-------|
| Standard | 2d | 7d | 2d | **11d** | 20% | Default for most proposals |
| Extended | 2d | 14d | 7d | **23d** | 30% | Auto-classified for high-impact selectors |
| VetoRatification | 0 | 7d | 0 | **7d** | 20% | Auto-created by veto mechanism only |
| Steward | 0 | 7d | 2d | **9d** | 20% | Pass-by-default; auto-created by `proposeStewardSpend()` only. The 2d execution delay provides a veto buffer — without it, a pass-by-default proposal that attracted no votes would be executable immediately after the voting window closes. |

All timing is set in the `ArmadaGovernor` constructor and is immutable for VetoRatification and Steward types (their params bypass `setProposalTypeParams()` bounds). Standard and Extended timing can be adjusted via governance within the configured bounds.

---

## A. ArmadaToken — ERC20Votes Delegation/Checkpoints

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| A1 | Self-delegate, query voting power in next block | Power equals token balance |
| A2 | Self-delegate in **same block** as proposal creation | Snapshot is `block.number-1`, so delegation has **zero** power for that proposal |
| A3 | Receive additional tokens **after** a proposal's snapshot block | No extra voting power for that proposal |
| A4 | Vote, then transfer all tokens away | Vote still counts at snapshot weight (vote-and-dump) |
| A5 | Transfer tokens during active voting, then receive tokens back before voting ends | Vote already cast still uses snapshot weight |
| A6 | Delegate, undelegate, re-delegate in **same block** | Single checkpoint reflecting final state |
| A7 | Multiple delegation changes across many blocks | Each creates a new checkpoint; binary search should find correct historical value |
| A8 | Self-delegate with zero balance | Should succeed; voting power = 0 |
| A9 | Query `getPastVotes` for a future block | Revert: "block not yet mined" |
| A10 | Query `getPastVotes` before any delegation (no checkpoints) | Returns 0 |
| A11 | Self-delegate with 1 wei of ARM | Should succeed; voting power = 1 wei |
| A12 | 10+ users delegate/transfer randomly | Sum of all voting power equals total delegated supply |
| A13 | Transfer ARM between accounts after snapshot | Neither account's voting power changes for existing proposals |
| A14 | Delegate to another address, then delegatee votes | Delegatee votes with delegator's balance |
| A15 | Change delegation mid-voting period | Vote already cast uses snapshot weight; new delegation doesn't affect it |

## B. ArmadaGovernor — Proposal Creation

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| B1 | Propose with exactly threshold amount delegated (0.1% of supply = 12K ARM) | Should succeed |
| B2 | Propose with 1 wei below threshold | Revert: "below proposal threshold" |
| B3 | Propose with tokens delegated in same block (snapshot is block-1) | Revert: "below proposal threshold" (power is 0 at snapshot) |
| B4 | Propose with empty targets array | Revert: "empty proposal" |
| B5 | Propose with mismatched array lengths (targets vs values vs calldatas) | Revert: "length mismatch" |
| B6 | Create two proposals in same block | Both succeed with sequential IDs |
| B7 | Delegate tokens, wait 1 block, transfer tokens away, propose in same block as transfer | Should succeed (snapshot at block-1 still has voting power) |
| B8 | Account with no delegated tokens tries to propose | Revert: "below proposal threshold" |
| B9 | Propose with a very long description | Should succeed (gas permitting); no length limit in contract |

## C. ArmadaGovernor — Voting

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| C1 | Vote exactly at `voteStart` timestamp | Should succeed |
| C2 | Vote 1 second before `voteStart` | Revert: "voting not started" |
| C3 | Vote exactly at `voteEnd` timestamp | Should succeed |
| C4 | Vote 1 second after `voteEnd` | Revert: "voting ended" |
| C5 | Vote For (1), Against (0), Abstain (2) | Each records correctly in tallies |
| C6 | Vote with support = 3 | Revert: "invalid vote type" |
| C7 | Vote twice on same proposal | Revert: "already voted" |
| C8 | Vote twice with different support values (e.g., For then Against) | Revert: "already voted" |
| C9 | Account with 0 delegated voting power at snapshot tries to vote | Revert: "no voting power" |
| C10 | Delegate voting power **after** proposal created, try to vote | Revert: "no voting power" (0 at snapshot) |
| C11 | Vote on non-existent proposal ID | Revert: "unknown proposal" |
| C12 | Vote on a canceled proposal during its original voting window | **Potential bug**: `castVote` checks timestamps not state — may allow voting on canceled proposals. See section N. |
| C13 | Many voters with tiny amounts | All votes should count; tallies accumulate correctly |

## D. ArmadaGovernor — Quorum & Outcome

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| D1 | Exactly meet quorum with For votes only | Succeeded |
| D2 | 1 wei below quorum | Defeated |
| D3 | Meet quorum but majority Against | Defeated |
| D4 | Meet quorum with **only** Abstain votes (0 For, 0 Against) | Defeated (`forVotes > againstVotes` → `0 > 0` = false) |
| D5 | Meet quorum with 1 For + many Abstain, 0 Against | Succeeded (1 > 0) |
| D6 | Equal For and Against votes (tie) | Defeated (`forVotes > againstVotes` is strict, tie loses) |
| D7 | Single whale meets quorum alone | Succeeded if they vote For |
| D8 | Treasury ARM balance changes between proposal creation and vote end | Quorum shifts (bug #19) — document actual behavior |
| D9 | Governance distributes ARM from treasury while proposal is active | Quorum increases (eligible supply grows) — could flip result |
| D10 | Large ARM donation to treasury during voting | Quorum decreases (eligible supply shrinks) — could flip result |
| D11 | Quorum for ParameterChange (20% of eligible) vs StewardElection (30%) | Both calculate correctly for their type |

## E. ArmadaGovernor — State Transitions & Timing

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| E1 | Check state at each lifecycle stage: Pending → Active → Succeeded → Queued → Executed | Each transition happens at correct timestamp |
| E2 | Proposal passes, sits in Succeeded state for months, then queue | Currently succeeds (no expiry — bug #22) |
| E3 | Cancel while Pending | State → Canceled |
| E4 | Cancel while Active (Standard/Extended) | Revert: "not pending or active" |
| E4a | Cancel Steward proposal while Active | State → Canceled (Steward proposals skip Pending due to zero voting delay, so Active is the earliest cancellable state) |
| E5 | Cancel while Succeeded/Queued/Executed | Revert: "not pending" |
| E6 | Non-proposer tries to cancel | Revert: "not proposer" |
| E7 | Queue a Defeated proposal | Revert: "not succeeded" |
| E8 | Queue an already-Queued proposal | Timelock reverts (already scheduled) |
| E9 | Execute before timelock delay | Timelock reverts |
| E10 | Execute already-Executed proposal | Revert: "not queued" |
| E11 | Execute proposal whose underlying call reverts | Revert: "TimelockController: underlying transaction reverted" |
| E12 | Two proposals queued simultaneously with different execution delays | Each should execute after its own delay |
| E13 | Proposal with non-zero ETH value in `values[]` | Caller must send matching `msg.value` to `execute()` |

## F. ArmadaTreasuryGov — Distributions

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| F1 | Distribute ARM from treasury | ARM transferred to recipient |
| F2 | Distribute USDC from treasury | USDC transferred to recipient |
| F3 | Distribute more than treasury balance | Revert (safeTransfer fails) |
| F4 | Distribute to zero address | Revert: "zero address" |
| F5 | Distribute 0 amount | Succeeds (no zero check exists — worth documenting) |
| F6 | Distribute entire treasury balance | Treasury balance → 0; steward budget → 0 |
| F7 | Non-owner calls distribute | Revert: "not owner" |
| F8 | Distribute, then check steward budget decreased | Budget is 1% of current (now lower) balance |

## G. ArmadaTreasuryGov — Steward Budget

Steward spending uses governance-configurable absolute per-token budgets with rolling windows
(via `StewardBudget` struct). Each token has an independent budget (`limit`) and window duration.
Steward spending is proposed through `ArmadaGovernor.proposeStewardSpend()` as pass-by-default
governance proposals. Both steward spend and governance distributions count against the same
aggregate outflow rate limit.

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| H1 | Steward spends within budget | Succeeds |
| H2 | Steward spends exactly the configured limit within the rolling window | Succeeds |
| H3 | Steward spends limit + 1 wei within the rolling window | Revert: "exceeds steward budget" |
| H4 | Multiple spends in same window, totaling under limit | All succeed |
| H5 | Multiple spends totaling over limit | Last one reverts |
| H6 | Window elapses → steward gets fresh budget | Succeeds; rolling window sum resets |
| H7 | Governance changes steward budget limit mid-window | New limit applies to next spend check |
| H8 | Governance distributes from treasury, aggregate outflow limit hit | Steward spend reverts even if steward budget allows it |
| H9 | Steward spends on token A, then token B | Independent budgets per token |
| H10 | Steward spends 0 amount | Revert: "zero amount" |
| H11 | Steward spends to zero address | Revert: "zero address" |
| H12 | Non-steward calls proposeStewardSpend | Revert: "not steward" |
| H13 | Steward budget token not authorized | Revert: "token not authorized for steward" |

## I. TreasurySteward — Election & Term

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| I1 | Elect steward via governance proposal | `currentSteward` set, `termStart` set, `isStewardActive` = true |
| I2 | Elect new steward while old term active | Replaces steward; new termStart |
| I3 | Remove steward via governance (`removeSteward`) | `currentSteward` → address(0), `isStewardActive` = false |
| I4 | Term expires (180 days) | `isStewardActive` = false |
| I5 | Steward tries to propose action after term expires | Revert: "term expired" |
| I6 | Elect steward with address(0) | Revert: "zero address" |
| I7 | Non-timelock calls electSteward | Revert: "not timelock" |

## J. Steward Spending via Governor (Pass-by-Default)

The steward action queue has been removed. Steward spending now flows through
`ArmadaGovernor.proposeStewardSpend()`, which creates pass-by-default governance proposals
(Steward type: 0 voting delay, 7d voting period, 2d execution delay). The 2d execution delay
provides a veto buffer. TreasurySteward is minimal identity management only (election, term, removal).

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| J1 | Steward proposes spend → 7d voting window passes with no votes → queue → execute | Succeeds (pass-by-default) |
| J2 | Steward proposes spend → community votes Against with quorum → proposal defeated | Defeated |
| J3 | Steward proposes spend → Security Council vetoes | Proposal canceled, veto ratification created |
| J4 | Steward proposes spend exceeding steward budget | Proposal passes governance but `stewardSpend()` execution reverts |
| J5 | Steward proposes spend exceeding aggregate outflow limit | Proposal passes governance but execution reverts |
| J6 | Steward removed mid-voting → proposal still active | Proposal remains but queueing reverts (steward check) |
| J7 | Steward term expires mid-voting → proposal still active | Queueing reverts (expired steward) |
| J8 | Non-steward calls proposeStewardSpend | Revert: "not current steward" |
| J9 | Steward proposes calldata classified as Extended | Revert: defense-in-depth check prevents Extended ops via pass-by-default path |

## K. Steward Veto (via Security Council)

Steward proposals are vetoed through the same Security Council veto mechanism as any other proposal.
The 2d execution delay on Steward proposals ensures the SC has time to intervene.

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| K1 | SC vetoes steward proposal during voting window | Proposal canceled, ratification proposal created |
| K2 | SC vetoes steward proposal during execution delay | Proposal canceled (if still queued) |
| K3 | Community overrides veto via ratification vote | Veto denied, proposal re-queued |

## L. Cross-System / End-to-End

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| L1 | Full lifecycle: delegate → propose → vote → queue → execute treasury distribution | Recipient receives tokens |
| L2 | Full steward lifecycle: elect → proposeStewardSpend → 7d pass-by-default → queue → execute | Spend succeeds within budget |
| L3 | Steward election → steward proposes → SC vetoes | Veto prevents execution |
| L4 | Two concurrent proposals, one distributes from treasury affecting quorum of the other | Quorum shifts (bug #19) — document behavior |
| L5 | Proposal to `transferOwnership(attacker)` on treasury | Requires Extended proposal (high-impact selector); SC can veto |
| L6 | Proposal to `removeSteward()` on TreasurySteward | Removes steward via governance |
| L7 | Proposal to change steward budget limits | Succeeds via timelock |
| L8 | Claim created → steward spends aggressively → claim exercise fails due to low balance | Race between claims and steward budget |
| L9 | Delegate tokens across multiple blocks, create proposal → verify snapshot uses `block.number - 1` at creation time | Only tokens delegated before that block count |
| L10 | Elect steward → steward spends budget → re-elect same steward (new term) → budget resets | Fresh budget period for new term's first spend |

## M. Adversarial / Social Attack Scenarios

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| M1 | **Vote-and-dump**: delegate → vote → transfer → sell before proposal executes | Works — no lock on tokens after voting |
| M2 | **Flash-delegation governance**: delegate massive amount at block N, propose at block N+1 | Proposal succeeds since snapshot = N, where tokens were delegated |
| M3 | **Quorum manipulation**: pass treasury distribution to shift quorum for concurrent proposals | Quorum changes live (#19) |
| M4 | **Budget front-run**: steward waits for large treasury deposit, proposes spend | Mitigated — budget is now absolute per-token with rolling window, not percentage-based |
| M5 | **Proposal spam**: lock minimum threshold, create many junk proposals | All succeed; wastes voter attention but costs gas |
| M6 | **Steward arbitrary call**: propose spend targeting sensitive function | Mitigated — proposeStewardSpend only allows stewardSpend calls; defense-in-depth rejects Extended-classified calldata |
| M7 | **Griefing via claim**: create claim for attacker, attacker drains treasury via exercise at worst time | Claim is governance-approved, but timing of exercise is uncontrolled |
| M8 | **Zombie proposal**: pass a proposal, wait 6 months, queue and execute | Works — no expiry (#22) |
| M9 | **Cancel as censorship**: proposer creates proposal to gain support, then cancels before voting starts | Proposer-only cancel during Pending enables this |
| M10 | **Quorum grief via treasury donation**: donate ARM to treasury to shrink eligible supply and raise effective quorum for all proposals | Works — anyone can transfer ARM to treasury |

## N. Voting on Canceled Proposals (Fixed)

`castVote()` now checks `p.canceled` before accepting votes. Attempting to vote on a canceled
proposal reverts with `Gov_ProposalCanceled()`. Tested in `GovernorVeto.t.sol`.

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| N1 | Create proposal, cancel while Pending, fast-forward to voting window, try to vote | Revert: `Gov_ProposalCanceled` |
| N2 | Vote on non-canceled proposal during voting window | Succeeds (regression check) |
