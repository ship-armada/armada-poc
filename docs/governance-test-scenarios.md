# Governance Test Scenarios & Edge Cases

Comprehensive test plan for the Armada governance system covering VotingLocker,
ArmadaGovernor, ArmadaTreasuryGov, and TreasurySteward contracts.

Scenarios marked with issue numbers (e.g., #19) reference known bugs filed on Codeberg.

---

## A. VotingLocker — Lock/Unlock/Checkpoints

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| A1 | Lock tokens, query voting power in next block | Power equals locked amount |
| A2 | Lock tokens in **same block** as proposal creation | Snapshot is `block.number-1`, so these tokens have **zero** power for that proposal |
| A3 | Lock additional tokens **after** a proposal's snapshot block | No extra voting power for that proposal |
| A4 | Vote, then immediately unlock all tokens | Vote still counts at snapshot weight (vote-and-dump, documented in #4) |
| A5 | Unlock all tokens during active voting, then re-lock before voting ends | Vote already cast still uses snapshot weight; new lock doesn't affect it |
| A6 | Lock, unlock, re-lock in **same block** | Single checkpoint reflecting final state |
| A7 | Multiple locks across many blocks | Each creates a new checkpoint; binary search should find correct historical value |
| A8 | Lock 0 tokens | Revert: "zero amount" |
| A9 | Unlock 0 tokens | Revert: "zero amount" |
| A10 | Unlock more than locked | Revert: "insufficient locked" |
| A11 | Lock 1 wei of ARM | Should succeed; voting power = 1 wei |
| A12 | Query `getPastLockedBalance` for a future block | Revert: "block not yet mined" |
| A13 | Query `getPastLockedBalance` before any locks (no checkpoints) | Returns 0 |
| A14 | 10+ users lock/unlock randomly | `totalLocked` always equals sum of individual balances (INV-G4 from foundry tests) |
| A15 | Transfer ARM between accounts after snapshot | Neither account's voting power changes for existing proposals |

## B. ArmadaGovernor — Proposal Creation

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| B1 | Propose with exactly threshold amount locked (0.1% of supply = 100K ARM) | Should succeed |
| B2 | Propose with 1 wei below threshold | Revert: "below proposal threshold" |
| B3 | Propose with tokens locked in same block (snapshot is block-1) | Revert: "below proposal threshold" (power is 0 at snapshot) |
| B4 | Propose with empty targets array | Revert: "empty proposal" |
| B5 | Propose with mismatched array lengths (targets vs values vs calldatas) | Revert: "length mismatch" |
| B6 | Create two proposals in same block | Both succeed with sequential IDs |
| B7 | Lock tokens, wait 1 block, unlock tokens, propose in same block as unlock | Should succeed (snapshot at block-1 still has tokens locked) |
| B8 | Account with no locked tokens tries to propose | Revert: "below proposal threshold" |
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
| C9 | Account with 0 locked tokens at snapshot tries to vote | Revert: "no voting power" |
| C10 | Lock tokens **after** proposal created, try to vote | Revert: "no voting power" (0 at snapshot) |
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
| E4 | Cancel while Active | Revert: "not pending" |
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

## G. ArmadaTreasuryGov — Claims

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| G1 | Create claim, exercise full amount at once | Beneficiary receives all tokens |
| G2 | Create claim, exercise in 3 partial amounts | Each partial works; `getClaimRemaining` decreases |
| G3 | Exercise more than remaining | Revert: "exceeds claim" |
| G4 | Non-beneficiary exercises claim | Revert: "not beneficiary" |
| G5 | Exercise 0 amount | Revert: "zero amount" |
| G6 | Create claim with 0 amount | Revert: "zero amount" |
| G7 | Create claim to zero address | Revert: "zero address" |
| G8 | Create claim, then treasury gets drained, then exercise | Revert (safeTransfer fails — insufficient balance) |
| G9 | Multiple claims for same beneficiary | All work independently |
| G10 | Exercise claim after treasury ownership changed | Should still work (claim data is in storage) |
| G11 | Create claim, never exercise | Sits forever (no revocation — bug #23) |

## H. ArmadaTreasuryGov — Steward Budget

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| H1 | Steward spends within budget | Succeeds |
| H2 | Steward spends exactly 1% of current balance | Succeeds |
| H3 | Steward spends 1% + 1 wei | Revert: "exceeds monthly budget" |
| H4 | Multiple spends in same period, totaling under 1% | All succeed |
| H5 | Multiple spends totaling over 1% | Last one reverts |
| H6 | Budget period expires → steward gets fresh budget | Succeeds; budgetSpent resets to 0 |
| H7 | Treasury receives large deposit mid-period | Budget increases on next spend (bug #24) |
| H8 | Governance distributes from treasury mid-period, balance drops below already-spent | getStewardBudget shows 0 remaining but no revert (already spent) |
| H9 | Steward spends on token A, then token B | Independent budgets per token |
| H10 | Steward spends 0 amount | Revert: "zero amount" |
| H11 | Steward spends to zero address | Revert: "zero address" |
| H12 | Non-steward calls stewardSpend | Revert: "not steward" |
| H13 | First spend in new period — verify `lastBudgetReset` sets to current timestamp (sliding window) | Period starts from first spend, not fixed schedule (bug #24) |

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

## J. TreasurySteward — Action Queue

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| J1 | Propose action → wait delay → execute | Succeeds |
| J2 | Propose action → execute before delay | Revert: "delay not elapsed" |
| J3 | Propose action → governance vetoes → try execute | Revert: "vetoed" |
| J4 | Execute already-executed action | Revert: "already executed" |
| J5 | Execute non-existent action ID | Revert: "unknown action" |
| J6 | Non-steward proposes action | Revert: "not steward" |
| J7 | Non-steward executes action | Revert: "not steward" |
| J8 | Steward A proposes action → Steward B elected → B executes A's action | Succeeds (new steward can execute old actions — related to #28) |
| J9 | Steward proposes action targeting arbitrary contract (not treasury) | Succeeds (bug #16) |
| J10 | Steward proposes stewardSpend over budget → execute | Execute reverts with garbled error (bug #29) |
| J11 | Multiple actions proposed, execute out of order | Should work (no ordering dependency) |
| J12 | actionDelay set to 0 via governance | Steward can propose and execute in same block (bug #17) |

## K. TreasurySteward — Veto

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| K1 | Veto before action delay elapses | Action un-executable |
| K2 | Veto already-executed action | Revert: "already executed" |
| K3 | Veto already-vetoed action | Revert: "already vetoed" |
| K4 | Veto non-existent action | Revert: "unknown action" |
| K5 | Non-timelock calls veto | Revert: "not timelock" |
| K6 | Race: action delay elapses during veto governance cycle | Steward can execute before veto finalizes — veto window shorter than governance cycle |

## L. Cross-System / End-to-End

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| L1 | Full lifecycle: lock → propose → vote → queue → execute treasury distribution | Recipient receives tokens |
| L2 | Full steward lifecycle: elect → propose action → wait delay → execute → verify treasury spend | Spend succeeds within budget |
| L3 | Steward election → steward acts → governance vetoes | Veto prevents execution |
| L4 | Two concurrent proposals, one distributes from treasury affecting quorum of the other | Quorum shifts (bug #19) — document behavior |
| L5 | Proposal to `transferOwnership(attacker)` on treasury | Succeeds — attacker gains permanent control (bug #18) |
| L6 | Proposal to `setSteward(address(0))` on treasury | Effectively removes steward |
| L7 | Proposal to `setActionDelay(0)` on steward | Removes veto window (bug #17) |
| L8 | Claim created → steward spends aggressively → claim exercise fails due to low balance | Race between claims and steward budget |
| L9 | Lock tokens across multiple blocks, create proposal → verify snapshot uses `block.number - 1` at creation time | Only tokens locked before that block count |
| L10 | Elect steward → steward spends budget → re-elect same steward (new term) → budget resets | Fresh budget period for new term's first spend |

## M. Adversarial / Social Attack Scenarios

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| M1 | **Vote-and-dump**: lock → vote → unlock → sell before proposal executes | Works — no lock on tokens after voting (#4) |
| M2 | **Flash-lock governance**: lock massive amount at block N, propose at block N+1 | Proposal succeeds since snapshot = N, where tokens were locked |
| M3 | **Quorum manipulation**: pass treasury distribution to shift quorum for concurrent proposals | Quorum changes live (#19) |
| M4 | **Budget front-run**: steward waits for large treasury deposit, immediately spends 1% of inflated balance | Works — budget is current balance (#24) |
| M5 | **Proposal spam**: lock minimum threshold, create many junk proposals | All succeed; wastes voter attention but costs gas |
| M6 | **Steward arbitrary call**: propose action targeting `treasury.transferOwnership(steward)` | Executes if not vetoed in time (#16) |
| M7 | **Griefing via claim**: create claim for attacker, attacker drains treasury via exercise at worst time | Claim is governance-approved, but timing of exercise is uncontrolled |
| M8 | **Zombie proposal**: pass a proposal, wait 6 months, queue and execute | Works — no expiry (#22) |
| M9 | **Cancel as censorship**: proposer creates proposal to gain support, then cancels before voting starts | Proposer-only cancel during Pending enables this |
| M10 | **Quorum grief via treasury donation**: donate ARM to treasury to shrink eligible supply and raise effective quorum for all proposals | Works — anyone can transfer ARM to treasury |

## N. Potential Bug — Voting on Canceled Proposals

`castVote()` checks `voteStart`/`voteEnd` timestamps but does **not** check `state()`. This means:

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| N1 | Create proposal, cancel while Pending, fast-forward to voting window, try to vote | **Needs investigation**: `castVote` only checks timestamps, not `canceled` flag. May allow votes on canceled proposals. |
| N2 | If N1 allows voting: votes accumulate on canceled proposal but `state()` always returns Canceled | Wasted gas, no security impact, but confusing behavior |

If confirmed, this should be filed as a separate bug — `castVote` should check `!p.canceled` before accepting votes.
