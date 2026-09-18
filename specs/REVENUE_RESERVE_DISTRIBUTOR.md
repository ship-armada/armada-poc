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
- Anyone can call `claim()` to collect newly unlocked ARM and pay **every recipient
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
address; it does not deploy a multisig or enforce a particular implementation's
threshold/owner ABI. Verify three intended owners and threshold two before launch.
Signer rotation can occur inside that multisig; its distributor role address is fixed.

## Which tokens receive batch payouts?

The wrapper cannot force claims for addresses registered directly in RevenueLock:
its existing `release()` pays only `msg.sender`.

| Deployment arrangement | Result |
|---|---|
| Known 17% registered directly in RevenueLock; remaining 3% allocated to distributor | Batch payouts cover only grants made from the 3% reserve. Direct beneficiaries keep their existing release path. |
| Entire 20% allocated to distributor; known 17% assigned internally before launch | Batch payouts cover both initial and later recipients; 3% remains initially assignable. All recipients must fit within the distributor's cap. |

Percentages are of total ARM supply. At the current 12M supply, the examples are
2.4M ARM total, 2.04M known allocations, and 360,000 ARM initially unassigned.
Choose one arrangement before deploying RevenueLock; its beneficiary list is fixed.
This implementation does not modify the existing production deployment scripts or
UI. The wiring below must be incorporated into the chosen launch deployment.

## Entry points

| Function | Caller | Effect |
|---|---|---|
| `bindRevenueLock(lock)` | Deployer, once | Permanently bind the original lock after it has been deployed with this distributor as beneficiary. |
| `assign(beneficiary, amount)` | Allocator, before wind-down | Add an irrevocable grant; emit `Assigned`. |
| `collect()` | Anyone | Pull all newly releasable reserve ARM; emit `Collected` when nonzero. No recipient payments. |
| `claim()` | Anyone | Collect if anything is newly releasable, then pay the entire list. Normal sponsored-payout operation. |
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
can call `collect()` permissionlessly and then claim, or use the normal `claim()`.

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

Normal `claim()` and `collect()` can fail if the upgradeable RevenueCounter fails
before wind-down. Already-collected entitlements remain available through the
cached-only payout paths, which read the original immutable lock's freeze flag but
never consult RevenueCounter. After complete collection, even normal `claim()`
skips upstream collection. After wind-down, the original lock's frozen release path
also avoids counter reads. Failed upstream wind-down itself is an inherited risk.

The allocator may assign all remaining capacity to itself (or an attacker if
compromised). A lost allocator multisig cannot be replaced here and may strand its
unassigned/fallback entitlement. Existing grants are unaffected. Direct token or
ETH donations are unsupported and have no rescue mechanism.

## Deployment order and verification

1. Deploy/verify the intended 2-of-3 multisig and existing ARM token.
2. Deploy the distributor with `(armToken, allocatorMultisig, reserveCap)`.
3. Deploy RevenueLock with that distributor as a beneficiary for exactly `reserveCap`.
4. Bind the distributor once, from its deployer. The binding checks token, allocation,
   zero prior release and unfrozen status; verify the exact deployed code/address too.
5. In token setup, include RevenueLock and distributor in the transfer whitelist.
   Authorize **RevenueLock only** as a delegator for this integration. Do not put the
   distributor in `noDelegation`: that would make upstream collection revert.
6. Include the distributor in the governor's quorum exclusions exactly once. Confirm
   the allocator is a usable wallet and not a protocol custody/excluded address.
7. Wire RevenueLock and the revenue counter to the intended wind-down contract;
   wire token/redemption as in the existing deployment. Fully fund and activate the lock.
8. Have the multisig assign initial grants, if using the full-20% arrangement. Publish
   recipients, amounts, cap, remaining reserve and the allocator/fallback policy.
9. Verify all settings and run the focused integration tests before launch. The
   binding deployer's remaining address field confers no further control.

Existing governance contracts are unchanged. The only existing file changed by
this implementation is a Hardhat compiler override for the new contract, matching
the current governance configuration (Solidity 0.8.20, Shanghai, optimizer 200).
The source pragma remains compatible with the repository's Solidity 0.8.17 baseline.

## Verification

Focused Foundry command, with the repository's locked OpenZeppelin **4.9.6** installed:

```sh
forge test --match-path 'test-foundry/RevenueReserveDistributor*.t.sol' \
  --use 0.8.20 --evm-version shanghai --optimize --optimizer-runs 200 -vv
```

The tests use real ArmadaToken, RevenueLock, RevenueCounter (proxy), ArmadaWindDown
and ArmadaRedemption. Only governor/pause shutdown callbacks and a settled crowdfund
are stubbed. Multisig signatures/owner management are outside this contract's tests;
allocator-address authorization is tested by impersonation.

Validation against base revision `532bc0641443879e30c07b98970f6e11d5d9400c`:

- Focused suite above: **29 passed**, including the three stateful invariants.
- Repository `npm run test:forge`: **793 passed**, with its default 0.8.17/London configuration.
- Hardhat governance integration, adversarial and veto suites: **116 passed**.
- Hardhat compilation succeeded. `npm run test` (privacy pool integration) stopped
  in its setup because the pinned Armada circuit artifacts were absent, before
  executing its test cases. No claim is made that this ZK integration suite passed.
- Distributor deployed bytecode: **6,610 bytes** with the Hardhat configuration.

Coverage includes cap exhaustion, irrevocable top-ups, inherited tiers, duplicate
claims, 50 grantees plus fallback, donation isolation, rejecting recipients, failure
rollback, counter outage, rate limiting, delegation checkpoints, zero/full/partial
wind-down, final-freeze milestone crossing, and both redemption orders. Stateful
invariants use **256 runs, 50 calls per run**, with final settlement checked too.

Gas measurements use cold contract/storage access and the compiler settings above:

| Scenario | Measured execution gas |
|---|---:|
| Collect and pay 50 undelegated grantees at first milestone | 3,224,696 |
| Collect and pay 50 separately delegated grantees plus allocator at wind-down | 5,625,923 |

These are measured call execution costs, not a live transaction fee quote. They
exclude transaction intrinsic gas and do not subtract transaction-level refunds.
Each gas test enforces an 8M execution-gas ceiling. Actual cost depends on state,
compiler settings and gas price; the sponsor pays it, not each recipient.
