# ArmadaCrowdfund — External State-Changing Function Modifier Matrix

Purpose: verify every externally-callable state-changing function on `ArmadaCrowdfund` retains its access-control and reentrancy guarantees when invoked via OZ `Multicall`'s `delegatecall`-to-self pattern.

OZ `Multicall.multicall(bytes[])` performs `Address.functionDelegateCall(address(this), data[i])`, which uses the `DELEGATECALL` opcode. Under DELEGATECALL:
- `msg.sender` is preserved (still the original EOA caller of `multicall`)
- `msg.value` is preserved (zero — no payable functions)
- All storage SLOADs/SSTOREs apply to `ArmadaCrowdfund`'s storage (same context)
- `address(this)` resolves to `ArmadaCrowdfund` itself

Therefore every modifier and inline `require` keyed on `msg.sender` or contract state continues to enforce its invariant identically. The matrix below confirms this case-by-case.

| # | Function | Modifier(s) | Inline access / state guards | Preserved under multicall? | Notes |
|---|---|---|---|---|---|
| 1 | `addSeeds(address[])` (l. 223) | `onlyLaunchTeam` | — | ✅ | `msg.sender == launchTeam` check is in the modifier; preserved |
| 2 | `addSeed(address)` (l. 231) | `onlyLaunchTeam` | — | ✅ | same as above |
| 3 | `loadArm()` (l. 261) | — | `!armLoaded`, balance ≥ required | ✅ | idempotent gate via storage flag |
| 4 | `invite(address, uint8)` (l. 279) | — | `phase == Active`, `armLoaded`, `block.timestamp ≤ windowEnd`, `msg.sender != launchTeam`, `inviter.isWhitelisted`, budget cap | ✅ | every gate is storage- or timestamp-keyed |
| 5 | `launchTeamInvite(address, uint8)` (l. 310) | — | `msg.sender == launchTeam`, launch-team invite window, fromHop gate, budget gate | ✅ | sender check still binds via DELEGATECALL |
| 6 | `commit(uint8, uint256)` (l. 345) | **`nonReentrant`** | `_requireActiveCommitWindow`, whitelist, MIN_COMMIT | ✅ | guard sets/clears `_status` per call; siblings in a bundle are independent ENTER/EXIT cycles |
| 7 | `commitWithInvite(...)` (l. 374) | **`nonReentrant`** | nonce/deadline/signature, whitelist, MIN_COMMIT | ✅ | EIP-712 digest binds to `inviter` not `msg.sender`; signature still validates |
| 8 | `revokeInviteNonce(uint256)` (l. 431) | — | nonce > 0, not used | ✅ | `usedNonces[msg.sender][nonce]` — sender-keyed mapping; preserved |
| 9 | `cancel()` (l. 442) | — | `msg.sender == securityCouncil`, phase gate | ✅ | sender check still binds |
| 10 | `finalize()` (l. 453) | **`nonReentrant`** | `block.timestamp > windowEnd`, phase gate | ✅ | permissionless; timestamp/phase still enforced |
| 11 | `claim(address)` (l. 558) | **`nonReentrant`** | phase finalized, not refundMode, `!claimed[msg.sender]`, has commitment | ✅ | sender-keyed `claimed` flag; `transferAndDelegate` audited SAFE (no reentry path) |
| 12 | `claimRefund()` (l. 605) | **`nonReentrant`** | refundMode \|\| Canceled, `!claimed[msg.sender]`, has commitment | ✅ | same `claimed` flag; `usdc.safeTransfer` is vanilla ERC20 |
| 13 | `withdrawUnallocatedArm()` (l. 634) | **`nonReentrant`** | phase ∈ {Finalized, Canceled}, sweepable > 0 | ✅ | permissionless; treasury-only recipient |

## Critical clarification — bundling `nonReentrant` siblings

`Multicall.multicall` itself is **not** `nonReentrant`. Each delegatecalled function executes its own guard cycle:
1. delegatecall to `data[i]` begins
2. `nonReentrantBefore`: assert `_status == NOT_ENTERED`, set `_status = ENTERED`
3. body executes
4. `nonReentrantAfter`: set `_status = NOT_ENTERED`
5. delegatecall returns
6. delegatecall to `data[i+1]` begins — `_status` is again `NOT_ENTERED`

Consequently a bundle like `multicall([commit(0, X), commit(1, Y), claim(d)])` **succeeds** — each `nonReentrant` sibling runs to completion before the next begins. The guard only blocks *nested* reentry within a single invocation (e.g. an external callee re-entering during step 3), which is unchanged by multicall.

**Test plan correction.** An originally-proposed test `test_Multicall_DoubleNonReentrant_Reverts` was wrong. The actual test is `test_Multicall_BundledNonReentrantSiblings_Succeed` — asserts state mutations from both calls land. This locks in the intended composition semantics so a future refactor (e.g. accidentally wrapping multicall in `nonReentrant`) is caught.

## True reentrancy surface — unchanged by Multicall

Reentrancy requires an external CALL whose target eventually re-enters `ArmadaCrowdfund` within the same outer invocation. The only contracts called from `ArmadaCrowdfund` state-changing functions are:

- `usdc.safeTransfer{,From}(...)` — vanilla ERC20, no hooks
- `armToken.balanceOf(...)` — view, no callbacks
- `armToken.safeTransfer(treasury, ...)` (in `withdrawUnallocatedArm`) — treasury is a trusted address, ArmadaToken has no transfer hooks (`_beforeTokenTransfer` does SLOADs only — see `reports/multicall/transferAndDelegate-audit.md`)
- `armToken.transferAndDelegate(...)` (in `claim`) — audited SAFE in the companion memo

No call-target inside any bundleable function reaches an attacker-controllable address. Adding `Multicall` introduces zero new external call sites.

## Functions explicitly NOT bundleable

These are `internal`/`private`/`view` and not directly callable via multicall:

- All `_*` helpers (`_initParticipant`, `_addSeed`, `_escrowCommit`, `_registerOrStackInvite`, `_effectiveCap`, `_requireActiveCommitWindow`, etc.)
- All view functions (`armStillOwed`, `getHopStats`, `getSaleStats`, `getEstimatedCappedDemand`, `isWhitelisted`, `getCommitment`, `getInvitesRemaining`, `getInviteEdge`, `computeAllocation`, `computeAllocationAtHop`, `getEffectiveCap`, `getInvitesReceived`, `getLaunchTeamBudgetRemaining`, `getParticipantCount`)

Views are still callable via multicall (and will return decoded data) but cannot mutate state. No risk surface.
