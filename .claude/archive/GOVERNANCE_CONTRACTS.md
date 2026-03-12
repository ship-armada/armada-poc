# Armada PoC Governance System — Implementation Spec

## Context

The crowdfund spec assumes a working governance system. This PoC validates the GOVERNANCE.md spec by building the core contracts and testing the essential mechanics: proposal lifecycle, token-locked voting, steward powers + veto, and treasury operations. Goal: identify complexity, implementation challenges, and design gaps before production.

## Architecture: 6 Contracts + Test Suite + Demo Tooling

```
contracts/governance/
  IArmadaGovernance.sol     — Shared enums, structs, events
  ArmadaToken.sol           — ARM ERC20 token (plain, no ERC20Votes)
  VotingLocker.sol          — Lock ARM → get voting power (with checkpoints)
  ArmadaGovernor.sol        — Proposal lifecycle, voting, quorum, execution
  ArmadaTreasuryGov.sol     — Governance-controlled treasury + claims
  TreasurySteward.sol       — Steward role, action queue, veto mechanism

test/
  governance_integration.ts — Full test suite covering all PoC scope items

scripts/
  deploy_governance.ts      — Deployment + configuration script
  governance_demo.ts        — Narrated end-to-end demo (one command, full flow)

tasks/
  governance.ts             — Hardhat tasks for individual governance actions
```

~900 lines Solidity, ~500 lines TypeScript tests, ~300 lines demo/tasks.

## Key Design Decision: Custom Governor + Token Locking (not OZ Governor)

**Why not OZ Governor:**
- OZ Governor uses delegation-based voting (`ERC20Votes.delegate(self)`). The spec says "lock tokens to vote" — a fundamentally different mechanic where tokens are held by the locker contract.
- OZ Governor has global `votingDelay()` and `votingPeriod()`. The spec requires per-proposal-type timing (standard: 5d voting / 2d delay vs extended: 7d / 4d).
- OZ `GovernorVotesQuorumFraction` computes quorum from total supply. The spec says "20% of ARM supply **outside treasury**" — needs custom quorum logic.
- Steward elections, veto, and typed proposals are all outside OZ Governor's design.

**Why not ERC20Votes on the token:**
- ERC20Votes tracks one delegate per address. When tokens are in the VotingLocker (holding tokens for N users), it can only delegate ALL tokens to one address — it cannot split delegation per depositor.
- Since all voting power comes from the locker's internal checkpoints, ERC20Votes would be unused overhead.
- Plain ERC20 is cleaner for PoC. ERC20Votes can be added later if delegation is desired.

**What we reuse from OZ:**
- `TimelockController` — used directly (not wrapped). Set `minDelay` to 2 days; the governor passes per-type delays when scheduling.
- `ERC20`, `SafeERC20`, `ReentrancyGuard` — standard building blocks.
- Checkpoint pattern — adapted from ERC20Votes' `_checkpoints` binary search for VotingLocker.

## Contract Summaries

### 1. `ArmadaToken.sol` — ARM Governance Token
Plain ERC20. 100M supply minted to deployer at construction (for PoC distribution). 18 decimals.

### 2. `VotingLocker.sol` — Token Locking + Checkpointing
- `lock(amount)` — transfer ARM to locker, increment user's locked balance, write checkpoint
- `unlock(amount)` — return ARM, decrement locked balance, write checkpoint
- `getPastLockedBalance(account, blockNumber)` — binary search checkpoints (same pattern as OZ ERC20Votes)
- Governor reads voting power from here, NOT from the token

### 3. `ArmadaGovernor.sol` — Core Governance (~300 lines, most complex)
- `propose(type, targets, values, calldatas, description)` — requires 0.1% of total supply locked
- `castVote(proposalId, support)` — FOR(1) / AGAINST(0) / ABSTAIN(2), weight from locker snapshot
- `queue(proposalId)` → schedules on OZ TimelockController with per-type delay
- `execute(proposalId)` → executes via TimelockController
- `cancel(proposalId)` — proposer can cancel while Pending
- `state(proposalId)` — returns lifecycle state
- `quorum(proposalId)` — `(totalSupply - treasuryBalance) * quorumBps / 10000`

Timing uses `block.timestamp` (easy to test with Hardhat `time.increase`). Snapshots use `block.number` (for checkpoint lookups).

**Proposal type parameters:**

| Type | Voting Delay | Voting Period | Execution Delay | Quorum |
|------|-------------|---------------|-----------------|--------|
| ParameterChange | 2 days | 5 days | 2 days | 20% |
| Treasury | 2 days | 5 days | 2 days | 20% |
| StewardElection | 2 days | 7 days | 4 days | 30% |

### 4. `ArmadaTreasuryGov.sol` — Governance Treasury + Claims
Owned by TimelockController (governance-controlled). Key functions:
- `distribute(token, recipient, amount)` — direct distribution (onlyOwner/timelock)
- `createClaim(token, beneficiary, amount)` — create exercisable claim (onlyOwner)
- `exerciseClaim(claimId)` — beneficiary exercises at their discretion
- `setSteward(address)` — governance sets steward (onlyOwner)
- `stewardSpend(token, recipient, amount)` — steward's 1% monthly budget

### 5. `TreasurySteward.sol` — Steward Action Queue + Veto
- `electSteward(address)` / `removeSteward()` — called by timelock after governance proposal
- `proposeAction(target, data, value)` — steward queues an action
- `executeAction(actionId)` — steward executes (after delay, if not vetoed)
- `vetoAction(actionId)` — called by timelock after governance veto proposal
- 6-month term tracking; actions rejected after term expires

## Deployment Order & Wiring

```
1. ArmadaToken(deployer)                         → mint 100M ARM to deployer
2. VotingLocker(armToken)
3. TimelockController(minDelay=2days, proposers=[], executors=[], admin=deployer)
4. ArmadaTreasuryGov(owner=timelock)
5. ArmadaGovernor(votingLocker, armToken, timelock, treasury)
6. TreasurySteward(governor=timelock, treasury)
7. Grant timelock PROPOSER_ROLE → governor
8. Grant timelock EXECUTOR_ROLE → governor (or address(0) for open execution)
9. Renounce deployer's TIMELOCK_ADMIN_ROLE
10. Distribute ARM: 65M → treasury, rest → test users
```

## Test Plan (maps to PoC scope)

```
1. Essential proposal types & functions
   - Create ParameterChange proposal → verify timing, quorum(20%), pass condition
   - Create Treasury proposal → verify standard quorum
   - Create StewardElection proposal → verify extended timing, quorum(30%)
   - Quorum calculation excludes treasury-held ARM

2. Essential create-proposal function testing
   - Init proposal → check threshold (0.1%), state transitions
   - "Token transfers on" → governance enables something via parameter change
   - "Pay Y address X USDC" → treasury proposal sends USDC to recipient
   - "Elect Y address steward" → steward election proposal

3. Essential steward mechanism testing
   - Steward spends within 1% monthly budget → succeeds
   - Steward spends above budget → reverts
   - Steward proposes action → tokenholder veto proposal → action vetoed
   - Steward term expiry → actions rejected

4. Essential voter functions
   - Lock tokens → voting power tracked
   - Cast vote (yes/no/abstain) → tallied correctly
   - Unlock tokens after voting → succeeds
   - Vote without locked tokens → reverts
```

## Unspecified Elements / Open Questions

1. **Steward action delay window**: Spec says tokenholders can veto, but no delay specified. PoC uses a configurable delay (default 1 day in production, shortened for tests). Without a delay, steward can execute before veto passes.

2. **Vote change constraints**: Spec mentions "constraints for changing yes/no vote" as unspecified. PoC: votes are final (no changing). Design note: allowing changes adds complexity (must subtract old vote, add new).

3. **Token unlock during active votes**: Can users unlock while they have active votes? PoC: yes (votes use snapshot at proposal creation, so unlocking after snapshot doesn't affect recorded votes). Production may want to prevent unlock until voting period ends for stronger guarantees.

4. **High-impact treasury detection**: Spec says >5% treasury allocation uses extended (30%) quorum. PoC: all treasury proposals use standard 20% quorum — detecting "high-impact" requires parsing calldata amounts against treasury balance. Noted for future.

5. ~~**Abstain counting for quorum**~~: RESOLVED — Abstain counts toward quorum but not for/against majority. This is the intended behavior.

6. **Multiple proposals from same proposer**: No limit specified. PoC: unlimited. Production may want a per-proposer active proposal cap.

7. **Security Council (3-of-5 multisig)**: Spec mentions pause authority + fast-track patches. Out of PoC scope — noted for future.

8. **Activity Shaping defaults**: Flagged as uncertain. Not implemented in PoC.

9. **Wind-down mechanism**: Spec has full wind-down sequence (withdraw-only MASP, treasury liquidation, pro-rata distribution). Out of PoC scope — noted as future integration test with core contracts.

10. **Fee structure governance**: The spec has detailed fee tiers, integrator volumes, yield fees. These are *governable parameters* but the fee contracts themselves are out of PoC scope. Future: governance proposals should be able to call fee-related setters.

## Demo & Interactive Testing Strategy

Integration tests validate correctness (pass/fail), but don't show the system from a user perspective. Instead of a frontend (overkill for PoC), we use two layers:

### Layer 1: Hardhat Tasks (`tasks/governance.ts`)

Individual governance actions callable from the CLI. Each task loads deployment addresses from `deployments/governance-hub.json`.

```bash
npx hardhat lock-tokens --amount 10000 --network hub
npx hardhat propose --type treasury --description "Pay Alice 500 USDC" --network hub
npx hardhat vote --proposal 1 --support for --network hub
npx hardhat proposal-state --proposal 1 --network hub
npx hardhat queue-proposal --proposal 1 --network hub
npx hardhat execute-proposal --proposal 1 --network hub
npx hardhat steward-spend --token USDC --to 0x... --amount 500 --network hub
```

### Layer 2: Narrated Demo Script (`scripts/governance_demo.ts`)

One-command full walkthrough against local Anvil with human-readable console output:

```
npx hardhat run scripts/governance_demo.ts --network hub
```

Covers two flows:
1. Treasury proposal: lock → propose "Pay Carol 500 USDC" → vote → queue → execute → verify balance
2. Steward election + spend + veto: elect steward → spend within budget → propose action → veto via governance

Uses `time.increase()` and `mine()` to fast-forward through delays. ~5 seconds runtime on local Anvil.

## Verification

1. `npx hardhat compile` — all new contracts compile without errors
2. `npx hardhat test test/governance_integration.ts` — all tests pass
3. `npx hardhat run scripts/governance_demo.ts --network hub` — narrated demo completes both flows
4. Individual tasks work against deployed system
5. Edge cases: below-threshold proposal rejected, quorum not met → defeated, term expired → rejected
