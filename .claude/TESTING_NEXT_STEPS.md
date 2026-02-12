# Testing & Audit Next Steps

## Current State

- **Governance**: 6 contracts, 35 integration tests, demo script, CLI tasks
- **Crowdfund**: 1 contract + interface, 51 integration tests (1 pending), demo script, CLI tasks
- **Total**: 86 tests passing, covering happy paths and basic access-control rejections

This is sufficient for PoC validation but not for production confidence. Below are the recommended next steps, ordered by priority.

---

## Phase 1: Static Analysis (immediate, ~1 hour)

Run automated tools against all contracts to catch known vulnerability patterns.

### Slither

```bash
pip install slither-analyzer
slither contracts/governance/ --exclude-dependencies
slither contracts/crowdfund/ --exclude-dependencies
```

Catches: reentrancy patterns, unchecked return values, dangerous state changes after external calls, shadowing, uninitialized storage, incorrect ERC20 interactions.

### Aderyn

```bash
cargo install aderyn
aderyn .
```

Catches: centralization risks, missing zero-address checks, unsafe casting, gas optimizations.

### What to look for specifically

- **ArmadaCrowdfund.sol**: `finalize()` iterates `participantList` unboundedly (L282-304) — Slither should flag this as a potential DoS vector
- **ArmadaGovernor.sol**: `_checkProposalThreshold()` reads `block.number - 1` (L162) — confirm Slither doesn't flag the unchecked subtraction (safe since constructor mines a block)
- **VotingLocker.sol**: `unlock()` transfers after state update (L76) — confirm CEI pattern is correct and ReentrancyGuard is sufficient

---

## Phase 2: Adversarial Unit Tests (~1-2 days)

Add targeted tests for attack vectors and edge cases not covered by current suite.

### 2a. Reentrancy Tests

**Crowdfund claim/refund reentrancy:**
Deploy a malicious contract that implements an ERC20 `receive()` callback attempting to re-enter `claim()` or `refund()`. Verify ReentrancyGuard blocks it.

```
MaliciousReceiver.claim() → ArmadaCrowdfund.claim() → ARM.transfer() → MaliciousReceiver.onTransfer() → ArmadaCrowdfund.claim() → REVERTS
```

Note: SafeERC20 + ReentrancyGuard should prevent this, but the test proves it.

**VotingLocker unlock reentrancy:**
Same pattern — malicious token callback during `unlock()` tries to re-enter `lock()` or `unlock()`.

### 2b. Precision & Accounting Invariants

**Sum-of-parts tests (crowdfund):**
After finalization with 100+ participants across all hops:
- `sum(allocations_arm) == totalAllocated` (exact, no dust)
- `sum(allocUsdc) + sum(refunds) == totalCommitted` (exact)
- `sum(allocUsdc) <= saleSize` (never exceeds sale)
- After all claims: `armToken.balanceOf(crowdfund) >= 0` and `usdc.balanceOf(crowdfund) >= 0` (contract never goes negative)

**Rounding edge cases:**
- Single participant commits 1 wei USDC (smallest possible)
- 199 participants each commit 1 USDC — test that rounding doesn't create/destroy value
- Pro-rata with prime-number demand vs reserve (e.g., demand=7,777,777, reserve=5,555,553) — maximizes rounding error

### 2c. Boundary Conditions

**Crowdfund boundaries:**
- Commit exactly at hop cap ($15,000.000000 USDC for hop-0) — should succeed
- Commit 1 wei over hop cap — should revert
- `totalCommitted` lands exactly at MIN_SALE ($1,000,000) — should finalize, not cancel
- `totalCommitted` lands exactly at ELASTIC_TRIGGER (1.5x BASE = $1,800,000) — should expand to MAX_SALE
- Finalize with 0 participants in hop-1 and hop-2 (seeds only) — no division by zero in rollover
- Finalize with 0 committers (all whitelisted, none committed) — should cancel

**Governance boundaries:**
- Cast vote at exact `voteStart` timestamp — should succeed
- Cast vote at exact `voteEnd` timestamp — should succeed
- Cast vote 1 second after `voteEnd` — should revert
- Proposal with `forVotes == againstVotes` — should be Defeated (not >)
- Quorum reached with 100% abstain votes — should be Defeated (abstain counts for quorum but `forVotes > againstVotes` fails)
- Propose with exactly threshold voting power (0.1% of supply)

### 2d. Access Control & State Machine

**Phase transition violations (crowdfund):**
- `commit()` during Invitation phase (before commitment window)
- `invite()` during Commitment phase
- `finalize()` before commitment ends
- `addSeeds()` after Setup phase
- `claim()` when phase is Canceled (should use `refund()`)
- Non-admin calls `finalize()`, `addSeeds()`, `startInvitations()`, `withdrawProceeds()`

**Governor state machine:**
- `queue()` a Defeated proposal — should revert
- `execute()` a proposal that was never queued — should revert
- `cancel()` a proposal that's already Active (voting started) — should revert
- Double-queue the same proposal — timelock should reject (same salt)

---

## Phase 3: Foundry Invariant / Fuzz Testing (~2-3 days)

Set up Foundry alongside Hardhat (they share the `contracts/` directory). Write stateful invariant tests.

### Setup

```bash
forge init --no-git --no-commit
# foundry.toml: src = "contracts", test = "test-foundry"
# remappings: @openzeppelin/=node_modules/@openzeppelin/
```

### Crowdfund Invariants

Write a `Handler` contract that randomly calls `invite()`, `commit()`, `finalize()`, `claim()`, `refund()` with fuzzed inputs. Assert after every call:

1. **Conservation of USDC**: `usdc.balanceOf(crowdfund) == totalCommitted - totalRefundedSoFar - totalProceedsWithdrawn`
2. **Conservation of ARM**: `armToken.balanceOf(crowdfund) == initialArmFunding - totalClaimedArm - unallocatedArmWithdrawn`
3. **No over-allocation**: For every participant, `allocation <= committed * 1e18 / ARM_PRICE`
4. **Phase monotonicity**: Phase only moves forward (Setup → Invitation → Commitment → Finalized/Canceled), never backward
5. **Hop cap enforcement**: No participant's `committed` ever exceeds their hop's `capUsdc`
6. **Invite graph is a tree**: No cycles, every non-seed has exactly one inviter, invitee hop = inviter hop + 1

### Governance Invariants

1. **No double voting**: `hasVoted[pid][voter]` prevents duplicate weight
2. **Vote tally consistency**: `forVotes + againstVotes + abstainVotes == sum of all voter weights`
3. **Checkpoint monotonicity**: For each user, checkpoints are strictly increasing in `fromBlock`
4. **Total locked consistency**: `totalLocked == sum of all individual locked balances` at any block

### Fuzz Targets

- `commit(uint256 amount)` — fuzz amount from 0 to 2x hop cap
- `invite(address)` — fuzz addresses including address(0), self, already-whitelisted
- `lock(uint256)` / `unlock(uint256)` — fuzz amounts, verify checkpoint correctness
- `castVote(uint256, uint8)` — fuzz proposalId (valid + invalid), support (0-255)

---

## Phase 4: Gas Profiling Under Load (~half day)

### Crowdfund `finalize()` Gas Ceiling

The `finalize()` function iterates all participants twice (hop allocation pass + individual allocation pass). Profile with:

| Participants | Expected Gas | Block Limit? |
|-------------|-------------|-------------|
| 100 | ~1M gas | OK |
| 500 | ~5M gas | OK |
| 1,000 | ~10M gas | Tight |
| 2,000 | ~20M gas | Over 15M limit |

If gas exceeds 15M (Ethereum mainnet block gas limit), the contract needs batched finalization for production. For L2 deployment this is less critical.

### Governance Gas

- `castVote()` with 1000+ checkpoints in VotingLocker (binary search depth)
- `queue()` and `execute()` with large calldata arrays (10+ targets)

### How to Profile

```bash
REPORT_GAS=true npx hardhat test test/crowdfund_integration.ts
```

Or write dedicated gas benchmark tests that output exact gas consumption.

---

## Phase 5: Formal Verification with Halmos (~1-2 days)

### Setup

```bash
pip install halmos
```

### Key Properties to Verify

**Crowdfund allocation math (highest value):**
```solidity
// For ALL possible (committed, reserve, demand) inputs:
// allocUsdc = (committed * reserve) / demand
// refund = committed - allocUsdc
// PROVE: allocUsdc + refund == committed (no dust created/destroyed)
// PROVE: allocUsdc <= committed (allocation never exceeds commitment)
// PROVE: allocUsdc <= reserve (allocation never exceeds reserve, given demand >= reserve)
```

**VotingLocker checkpoint search:**
```solidity
// For ALL possible checkpoint arrays and block numbers:
// getPastLockedBalance returns the correct value
// (the value at the largest checkpoint.fromBlock <= blockNumber)
```

Halmos performs symbolic execution — it proves properties hold for ALL inputs, not just random samples. This is the strongest guarantee short of a manual audit.

---

## Phase 6: Cross-Contract Integration Tests (~1 day)

### End-to-End Flow

Test the full lifecycle across contracts:

1. Deploy ARM token, USDC, Crowdfund, VotingLocker, TimelockController, Governor
2. Run crowdfund: seeds → invite → commit → finalize → claim ARM
3. Participant locks claimed ARM in VotingLocker
4. Participant creates governance proposal (verify they meet threshold)
5. Multiple crowdfund participants vote
6. Queue → timelock delay → execute
7. Verify executed action took effect

### Token Supply Consistency

- ARM total supply = 100M (ArmadaToken)
- Crowdfund allocates up to 1.8M ARM from admin deposit
- Governance quorum is based on `totalSupply - treasuryBalance`
- Verify quorum calculations remain correct after crowdfund distributes tokens
- Verify proposal threshold (0.1% of total supply = 100K ARM) is reachable by crowdfund participants

### Adversarial Cross-Contract

- Participant claims ARM from crowdfund, locks in VotingLocker, then unlocks and transfers to another address. Second address tries to vote — should fail (no voting power at snapshot block)
- Governance proposal that calls `crowdfund.withdrawProceeds()` via timelock — verify only works if timelock has admin role

---

## Summary: Priority Matrix

| Phase | Effort | Value | Risk Coverage |
|-------|--------|-------|---------------|
| 1. Static analysis | 1 hour | High | Known vulnerability patterns |
| 2. Adversarial unit tests | 1-2 days | High | Reentrancy, precision, boundaries |
| 3. Foundry invariant/fuzz | 2-3 days | Very High | Unknown edge cases via random exploration |
| 4. Gas profiling | Half day | Medium | Scalability limits |
| 5. Halmos verification | 1-2 days | Very High | Mathematical correctness proofs |
| 6. Cross-contract integration | 1 day | Medium | System-level interactions |

**Minimum for production confidence:** Phases 1-3.
**Full audit preparation:** All 6 phases, then engage an external auditor with the test suite + formal proofs as supporting evidence.

---

## Open Questions for Production

1. **Batched finalization**: `finalize()` is O(n) over participants. Production needs batched processing or off-chain computation with on-chain verification (Merkle proof of allocations).
2. **Emergency cancel**: No admin emergency cancel exists during the commitment window. Should it?
3. **Invite graph privacy**: `getInviteEdge()` restricts view access, but storage is readable via `eth_getStorageAt`. Production may need commit-reveal or ZK proofs.
4. **Timelock admin transfer**: Governor proposals execute through TimelockController, but who is the initial timelock admin? Needs careful role setup for production.
5. **Upgrade path**: All contracts are non-upgradeable. If bugs are found post-deployment, the only option is migration. Consider proxy pattern for production.
