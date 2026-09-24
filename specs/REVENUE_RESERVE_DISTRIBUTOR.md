# Revenue reserve distributor

Implementation: `contracts/governance/RevenueReserveDistributor.sol`.

This adds irrevocable, later-assigned grants and sponsored batch payouts without
editing any existing governance contract. It is new code requiring review; the
existing RevenueLock audit does not cover this distributor or its integration.

## Behavior

- A fixed allocator address, intended to be an existing **2-of-3 multisig**, chooses
  each recipient, assignment amount, and assignment time.
- Grants can only increase. Neither the allocator nor deployer can revoke,
  reduce, redirect, or reclaim them. Self-assignment is allowed.
- The lifetime assignment cap is fixed at deployment. Claims never replenish it.
- New grants inherit milestones already achieved. There is no separate vesting clock.
- Anyone can call `distribute()` to collect newly unlocked ARM and pay **every recipient
  registered in the distributor**, including the allocator's entitlement, if any.
- The caller pays gas; payments always go to the recorded addresses. No signatures
  from recipients, server approval, or allocator action are needed to claim.
- The list is bounded at **50 distinct non-allocator grantees plus the allocator**.
  The allocator always occupies index 0, so its wind-down fallback cannot be blocked
  by exhausting the other slots. Top-ups do not consume extra slots.
- Assignment authority ends as soon as `RevenueLock.frozenAtWindDown()` is true.
  The unassigned remainder automatically becomes the allocator's entitlement.
- Wind-down does not unlock additional milestones. The unlocked portion remains
  claimable; the still-locked portion stays in the original lock permanently.

The multisig enforces its own signing policy. The distributor authenticates its
address and does not implement multisig signatures. The launch scripts require a
deployed Safe-compatible wallet reporting three distinct owners and threshold two;
these getters are consistency checks, not authentication of wallet code. Verify the
intended chain and Safe address, proxy/implementation, all three owner identities,
modules, guards and fallback handler independently before launch. A contract that
merely returns the expected getters passes this check (as the test mock does), as
does a genuine but unintended Safe. Record this out-of-band verification in the
launch checklist; automated getter success is not sign-off. Signer
rotation can occur inside that multisig; its distributor role address is fixed.

## Allocation and payout scope

RevenueLock holds the combined **20% of total ARM supply** early-network allocation.
The reserve distributor is one of its immutable beneficiaries. Its exact cap is a
launch parameter taken from the approved cap table, not a fixed 3% allocation.
Other RevenueLock beneficiary entries plus the reserve must total 2,400,000 ARM.
This PR changes reserve custody and assignment mechanics, not category ownership.

**Worked example only:** at 12M total supply, a 360,000 ARM reserve would produce:

| RevenueLock beneficiary | ARM allocation | Share of total supply |
|---|---:|---:|
| Other beneficiary entries, combined | 2,040,000 | 17% |
| RevenueReserveDistributor | 360,000 | 3% |
| **Total in RevenueLock** | **2,400,000** | **20%** |

The example and test fixtures are not approval to replace a 120,000 ARM (1%) cap-table
reserve with 360,000 ARM. If the final cap is 120,000 ARM, other entries must total
2,280,000 ARM (19%). Freeze the approved amount, controlling Safe, category breakdown,
and full recipient schedule in the launch parameter manifest before deployment.

The airdrop remains a separate Merkle-distribution path; this PR does not make every
airdrop recipient a direct RevenueLock beneficiary or implement that distributor.
If the airdrop budget is held within this RevenueLock, its distribution contract must
be represented in the immutable beneficiary schedule and separately reviewed for
release, delegation, transfer restrictions, and wind-down compatibility. Do not
substitute individual airdrop recipients merely to make these scripts pass.

**Sponsored batches cover only reserve assignees.** Other RevenueLock beneficiaries
retain their existing `release()` path, which only pays its caller. The full-20%
wrapper alternative is outside this design. The reserve's 50 non-allocator slots do
not constrain the separate airdrop. The allocator occupies its own reserved slot.
There is no UI integration in this PR.

## Entry points

| Function | Caller | Effect |
|---|---|---|
| `bindRevenueLock(lock)` | Deployer, once | Permanently bind the original lock after it has been deployed with this distributor as beneficiary. |
| `verifyIntegration()` | Anyone, view | Return true or revert on incomplete token initialization, wrong lock allocation/token, or unsafe source/distributor permissions. Required before funding. |
| `assign(beneficiary, amount)` | Allocator, before wind-down | Add an irrevocable grant; emit `Assigned`. |
| `collect()` | Anyone | Pull all newly releasable reserve ARM; emit `Collected` when nonzero. No recipient payments. |
| `distribute()` | Anyone | Collect if anything is newly releasable, then pay the entire list. Normal sponsored-payout operation. |
| `claimCollected()` | Anyone | Pay the entire list from already-collected entitlements without consulting RevenueCounter. |
| `claimRange(start, end)` | Anyone | Pay indexes `[start, end)` from already-collected funds. Smaller-transaction fallback. |
| `claimSelf()` | Anyone | Pay only the caller from already-collected funds. Individual fallback. |
| `claimable(beneficiary)` | Anyone, view | Amount payable from funds already collected. Does not preview the next collection. |
| `effectiveAllocation(beneficiary)` | Anyone, view | Explicit grant plus the allocator's automatic fallback after wind-down. |
| `remainingAssignable()` | Anyone, view | Remaining capacity before wind-down, zero afterward. |
| `unassigned()` | Anyone, view | Accounting remainder `reserveCap - totalAssigned`; after wind-down this belongs to the allocator. |
| `beneficiaryCount()` / `beneficiaries(index)` | Anyone, view | Enumerate the bounded list; allocator is index 0. |

The payout/collection functions return the amount transferred or collected. Zero due
is a successful no-op. Payouts emit `Claimed` only for nonzero amounts. Before the
one-time binding, operational functions revert. Collection requires activation of
the original lock. Cached-only payout functions cannot pay before a successful
collection, even if someone directly donates tokens to the distributor.

There is no persistent batch cursor: repeat or overlapping ranges cannot double-pay.
`claimSelf()` is not a collection operation. A beneficiary needing the latest tier
can call `collect()` permissionlessly and then claim, or use the normal `distribute()`.

## Accounting

Let `R = reserveCap`, `S = totalAssigned`, and `G[b] = assigned[b]`.

```text
effectiveAllocation(b) = G[b]                  before wind-down
effectiveAllocation(b) = G[b]                  after wind-down, b != allocator
effectiveAllocation(b) = G[b] + R - S          after wind-down, b == allocator

collectedBps = RevenueLock.released(distributor) / (R / 10,000)
entitled(b) = effectiveAllocation(b) * collectedBps / 10,000
payment(b) = entitled(b) - claimed[b]
```

`totalCollected` and `collectedBps` are updated only after a successful upstream
release and atomic undelegation. Neither token balance nor donations determine
entitlement. The original lock's ratchet and milestone schedule remain authoritative.

`R` and every grant must be positive multiples of **10,000 ARM base units**
(`0.00000000000001 ARM`). This makes all basis-point entitlements exact, including
the fallback, without new rounding dust. It does not fix unrelated rounding in
other contracts or in direct RevenueLock allocations.

After wind-down, effective allocations sum to `R`. Existing allocator grants and
previous claims are retained: the fallback only adds the unassigned remainder.
No finalization transaction or token movement at the trigger is needed.

Unvested ARM remains in the original lock and excluded by its existing
`lockedAtWindDown()` calculation. Unlocked reserve ARM remains in the redemption
denominator whether held by RevenueLock, distributor, or normal recipient wallets.
Claiming the fallback does not newly add it to the denominator. It was already
included. Do not add the distributor to redemption exclusions or return its reserve
to treasury. Grants are intended for usable beneficiary wallets, not protocol
custody, treasury, redemption, or other quorum-excluded addresses.

## Delegation and batch tradeoffs

The original lock insists on a nonzero delegation target. Collection therefore
calls `RevenueLock.release(address(distributor))`, then `ARM.delegate(address(0))`
within the same transaction. If undelegation fails, the whole transaction reverts.
The distributor exposes no voting or arbitrary-call function.

Payouts use normal ARM transfers. They preserve recipients' existing delegation.
Recipients without delegation must delegate their own wallet separately to vote;
the distributor has no authority to choose delegates for other accounts.

Sponsor-triggered payouts can increase the quorum-eligible circulating balance
before recipients delegate or actively participate. This is an explicit consequence
of the requested batch behavior, not a governance-side mitigation. Include the
distributor in the governor's quorum-exclusion list so its remaining balance does
not inflate quorum before payout.

Actual ArmadaToken transfers do not invoke recipient hooks, so a rejecting wallet
cannot block a batch. A token transfer failure or out-of-gas still reverts the whole
batch atomically. The caller can use smaller ranges or an individual payout. Failed
transactions do not consume entitlements. Caller-supplied payout addresses,
configurable delegate targets, sweep functions and token approvals are not exposed.

Normal `distribute()` and `collect()` can fail if the upgradeable RevenueCounter fails
before wind-down. Already-collected entitlements remain available through the
cached-only payout paths, which read the original immutable lock's freeze flag but
never consult RevenueCounter. After complete collection, even normal `distribute()`
skips upstream collection. After wind-down, the original lock's frozen release path
also avoids counter reads. Failed upstream wind-down itself is an inherited risk.

The allocator may assign all remaining capacity to itself (or an attacker if
compromised). A lost allocator multisig cannot be replaced here and may strand its
unassigned/fallback entitlement. Existing grants are unaffected. Direct token or
ETH donations are unsupported and have no rescue mechanism.

## Deployment order and verification

1. Verify the intended ARM token, allocator wallet code and three owners with threshold two.
2. Configure both `REVENUE_RESERVE_ALLOCATOR` and `REVENUE_RESERVE_AMOUNT` (ARM token units,
   e.g. `360000`). The reserve is optional in the generic scripts; both variables are
   required for this launch design. Neither is defaulted or inferred.
3. Supply `REVENUE_LOCK_BENEFICIARIES_FILE` or `REVENUE_LOCK_BENEFICIARIES_JSON` with the
   **direct** beneficiaries only (2,040,000 ARM for the example). Do not include another
   entry for the reserve. Direct amounts plus the reserve must equal
   `ARM_REVENUE_LOCK_ALLOCATION` (2,400,000 ARM). A full 2.4M direct list plus a 360k
   reserve fails before any deployment transactions.
4. `deploy_governance.ts` deploys the distributor, appends its address and exact cap to
   the lock's constructor arrays, deploys RevenueLock, and immediately binds the two.
   The manifest records `contracts.revenueReserveDistributor`. The binding caller must
   be the distributor's constructor `msg.sender`: a factory/CREATE2 helper deployment
   requires that helper to expose/execute the binding call. Funding an unbound lock
   strands its reserve if that caller becomes unavailable.
5. `deploy_crowdfund.ts` requires agreement between reserve config and manifest, and
   reads back `RevenueLock.totalAllocation()` against the configured funding amount
   and compares the beneficiary count and every unique address/allocation (including
   the distributor) with the immutable lock. Equal totals alone are insufficient.
   These checks run before any crowdfund-stage one-shot initialization, even without a
   reserve. Changing environment files between deployment stages must not silently
   change the funding budget or recipients. Token initialization finishes before
   funding: source and distributor are whitelisted,
   RevenueLock is an authorized delegator, and the distributor is neither an authorized
   delegator nor in `noDelegation`. All three token initialization flags must be set.
6. Include crowdfund, RevenueLock and distributor in governor quorum exclusions exactly
   once. Keep the allocator outside the treasury and excluded custody addresses.
7. Deploy and wire wind-down/redemption, including the immutable lock's one-shot
   wind-down binding and RevenueCounter's binding, **before funding RevenueLock**.
8. Before **any ARM distribution**, including the treasury transfer, the script runs
   `assertReservePreFunding()` in `scripts/revenue-reserve.ts`. It checks:
   - intended token, lock, allocator and cap, plus `verifyIntegration()`;
   - exact equality of `RevenueLock.totalAllocation()` and the configured lock funding;
   - exact beneficiary count and every configured address/allocation, including reserve;
   - an unfunded, inactive, unfrozen lock with no prior reserve releases;
   - lock/distributor quorum exclusions and an allocator outside the treasury, exclusions, and `noDelegation` set;
   - token/governor/lock/counter wind-down bindings and the wind-down contract's
     reciprocal token/governor/lock/counter references;
   - the allocator's 2-of-3 owner/threshold getters again.
9. Fund, run exact-balance/supply checks, ensure activation despite competing callers,
   and check the redemption denominator. Initialize treasury limits, raise the production
   timelock delay, save manifests, and renounce bootstrap roles. Complete post-deployment
   verification before announcing launch.
   Publish direct allocations, reserve cap, allocator address, subsequent assignments
   and the wind-down fallback policy.

Governance deployment persists the original `revenueLockConstructorArgs` in its
manifest, including ordered beneficiaries and base-unit amounts. Explorer verification
uses that original order even if current configuration is reordered, checks the
immutable values and intended allocations, and verifies both RevenueLock and the
reserve distributor. Old manifests missing these arguments must recover them from
the original deployment transaction; verification fails explicitly rather than guessing
an order from the latest environment file.

Activation is permissionless. The deployment helper accepts an already activated lock,
estimates before reserving a nonce, and tolerates a confirmed mined activation revert
only when the lock is activated. Ambiguous send failures still abort. This prevents
an outsider's earlier activation from skipping treasury limits, production timelock
delay, manifest writes, and bootstrap-role renunciation. Post-deployment verification
checks the actual `TIMELOCK_ADMIN_ROLE`; hardened mode fails on retained deployer
admin/proposer/executor/canceller roles or an incorrect production delay, including
when an interrupted launch has not written its final crowdfund manifest.

**Funding is the irreversible boundary, including before activation.** A failed
pre-funding check aborts the script before treasury, RevenueLock or crowdfund receives
ARM. Earlier one-shot initialization may still require redeployment; this is not a
transactional or automatically resumable launch. `activate()` checks only that the
lock balance is at least its allocation and will accept permanently stranded excess.
Correct or redeploy an unsafe setup before funding; `activate()` is not a recovery path.
These read checks do not authenticate bytecode or atomically constrain another privileged
transaction between the checks and funding. Coordinate bootstrap keys and independently
verify code/addresses. Token governance can later add privileges; `verifyIntegration()`
reports current state and is deliberately not enforced inside payout functions.

The wind-down remainder is a conditional allocation to the allocator multisig. If
that wallet is team-controlled, disclose that control and fallback in the cap table
and crowdfund materials. The fallback includes only the unassigned entitlement; its
unlocked portion is payable and its locked portion stays permanently locked.

Existing governance contract sources remain unchanged. Scripts and documentation are
updated for integration; the new contract's Hardhat override follows current governance
settings (Solidity 0.8.20, Shanghai, optimizer 200). The source remains compatible with
the repository's Solidity 0.8.17 baseline. Durable decisions belong in
[the canonical team strategy log](https://github.com/ship-armada/team/blob/main/STRATEGY_LOG.json); migration of the earlier local entry
is pending. The allocation example is not a converged cap-table decision.

## Verification

Focused Foundry command, with the repository's locked OpenZeppelin **4.9.6** installed:

```sh
forge test --match-path 'test-foundry/RevenueReserve*.t.sol' \
  --use 0.8.20 --evm-version shanghai --optimize --optimizer-runs 200 -vv
```

The tests use real ArmadaToken, RevenueLock, RevenueCounter (proxy), ArmadaWindDown
and ArmadaRedemption. The Foundry integration fixture stubs governor/pause shutdown
callbacks and a settled crowdfund. The Hardhat deployment suite additionally uses the real ArmadaGovernor to
check payouts before and after proposal creation, unchanged existing eligible-supply
snapshots, the full-unlock 20%/30% quorum increases, and undelegated recipient votes.
Multisig signatures/owner management are outside this contract's tests;
allocator-address authorization is tested by impersonation. The pre-funding tests
exercise incomplete initialization, blocked delegation, missing permissions, wrong
allocator/cap, quorum omissions, and mismatched wind-down wiring. The deployment
fixture derives its deadline from the current block timestamp; a regression test
advances the clock beyond the former fixed deadline to catch suite-order dependence.

Validation against base revision `532bc0641443879e30c07b98970f6e11d5d9400c`:

- Focused suite above: **34 passed**, including the three stateful invariants.
- Repository `npm run test:forge`: **798 passed**, with its default 0.8.17/London configuration.
- Hardhat governance integration, adversarial and veto suites plus reserve deployment guards: **125 passed**.
- Network configuration tests: **9 passed** using
  `node --no-experimental-strip-types node_modules/mocha/bin/_mocha --require ts-node/register 'config/*.test.ts'`.
  The plain npm command encounters this runtime's native TypeScript/ESM loader mismatch.
- Actual CCTP/governance/crowdfund deployment scripts completed on local Anvil both
  with the 360,000 ARM reserve enabled and with the legacy no-reserve configuration.
  The local wallet fixture only implements Safe owner/threshold introspection; actual
  multisig signature execution is outside this test scope.
- Hardhat compilation succeeded. Repository-wide TypeScript checking still reports
  errors outside the changed files. `npm run test` (privacy pool integration) stopped
  in its setup because the pinned Armada circuit artifacts were absent, before
  executing its test cases. No claim is made that this ZK integration suite passed.
- Distributor deployed bytecode: **7,931 bytes** with the Hardhat configuration.

Coverage includes cap exhaustion, irrevocable top-ups, inherited tiers, duplicate
claims, 50 grantees plus fallback, donation isolation, rejecting recipients, failure
rollback, counter outage, rate limiting, delegation checkpoints, zero/full/partial
wind-down, final-freeze milestone crossing, and both redemption orders. Stateful
invariants use **256 runs, 50 calls per run**, with final settlement checked too.

Gas measurements use cold contract/storage access and the compiler settings above:

| Scenario | Measured execution gas |
|---|---:|
| Collect and pay 50 undelegated grantees at first milestone | 3,224,650 |
| Collect and pay 50 separately delegated grantees plus allocator at wind-down | 5,625,877 |

These are measured call execution costs, not a live transaction fee quote. They
exclude transaction intrinsic gas and do not subtract transaction-level refunds.
Each gas test enforces an 8M execution-gas ceiling. Actual cost depends on state,
compiler settings and gas price; the sponsor pays it, not each recipient.

## Mainnet acceptance evidence

Before funding, attach the following to the launch review:

- Approved cap table and exact constructor schedule, including the airdrop distribution
  contract/path, reserve cap, allocator control, and unassigned wind-down fallback.
- Independent verification that the actual allocator Safe has exactly three identified
  owners and threshold two, with its chain/address, implementation, modules, guard,
  and fallback handler reviewed. Do not relax the 2-of-3 check to accommodate a different
  wallet without an explicit design decision.
- Written scope acceptance from the Phase 1 auditor (Cyfrin/Dacian) covering
  `RevenueReserveDistributor.sol`, its ARM/RevenueLock/governor/redemption/wind-down
  interactions, and the revised governance/crowdfund deployment and verification
  sequence. Record the exact reviewed commit, auditor acknowledgement, findings, and
  disposition. Prior RevenueLock or Phase 1 coverage does not establish this coverage.

These are outstanding launch evidence requirements, not confirmations obtained by
this PR. The project audit handoff tracks the scope amendment.
