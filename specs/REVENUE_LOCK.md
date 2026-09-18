# Revenue-Lock Contract — Behavior Spec

## 1. Purpose

A single shared contract that holds all early network ARM (2,400,000 total: team, advisors, airdrop and the later-assigned reserve) and releases it to beneficiaries as cumulative protocol revenue milestones are reached. This is the enforcement mechanism for revenue-gated token unlocks described in GOVERNANCE.md and ARM_TOKEN.md.

**This is a contract behavior spec.** It defines what the contract does, what it reads, and what it guarantees.

---

## 2. Architecture

```
RevenueCounter (UUPS proxy, governance-upgradeable)
  └── recognizedRevenueUsd() → uint256

RevenueLock (immutable, non-upgradeable)
  ├── reads: RevenueCounter.recognizedRevenueUsd() — via ratchet only
  ├── stores: maxObservedRevenue (monotonic, rate-limited)
  ├── stores: lastSyncTimestamp (advances unconditionally on every sync)
  ├── immutable: MAX_REVENUE_INCREASE_PER_DAY
  ├── holds: 2,400,000 ARM (early network)
  ├── tracks: per-beneficiary allocations and released amounts
  └── releases: ARM to beneficiary wallet + delegates atomically via transferAndDelegate()

ARM Token
  ├── whitelist includes RevenueLock address (one-time init)
  └── transferAndDelegate() callable by RevenueLock (one-time delegator init)
```

RevenueLock never reads `RevenueCounter.recognizedRevenueUsd()` directly for entitlement calculations. All reads go through `_updateMaxObservedRevenue()`, which enforces the monotonic ratchet and rate cap before updating `maxObservedRevenue`. Entitlement is always computed from `maxObservedRevenue`, not the raw counter value.

---

## 3. Deployment

### Constructor parameters

| Parameter | Value | Notes |
|---|---|---|
| ARM token address | Immutable | Must match the ARM token that whitelists this contract |
| RevenueCounter address | Immutable | UUPS proxy address — implementation may be upgraded by governance, but the proxy address never changes |
| Beneficiary list | Immutable | Array of `(address beneficiary, uint256 allocationAmount)` pairs. Set once at deployment. |
| Milestone table | Immutable | The revenue-to-unlock-percentage mapping. Hardcoded or constructor-set. Cannot be changed after deployment. |
| `MAX_REVENUE_INCREASE_PER_DAY` | Immutable | Maximum rate at which `maxObservedRevenue` can advance per elapsed day. Set at deployment; not governance-settable. See PARAMETER_MANIFEST.md. |

Constructor must initialize: `maxObservedRevenue = 0`, `lastSyncTimestamp = block.timestamp`. The sync timestamp **must not** be left as 0 — a zero timestamp would allow the first call to accumulate the entire elapsed-time allowance since the Unix epoch and bypass the rate limit entirely.

### Post-deployment setup

ARM is distributed to this contract as part of the bootstrap-holder distribution sequence (see ARM_TOKEN.md §3). After distribution: `ARM.balanceOf(revenueLockContract) == 2_400_000e18`.

### Deployment order

The current deployment uses one-time initialization and binding calls rather than
requiring precomputed addresses. Deploy ARM and RevenueCounter first. For the reserve,
deploy its distributor before RevenueLock, include its address and exact allocation
in the lock's constructor, then bind the distributor immediately. Finish token
permissions, governor exclusions and wind-down wiring, then pass the reserve's
pre-funding checks **before** transferring ARM into the lock. See the reserve spec's
deployment sequence. Funding cannot be undone, even before `activate()`.

---

## 4. Beneficiary List

Set at deployment. Cannot be modified after deployment.

| Beneficiary | Allocation | Notes |
|---|---|---|
| Recipient 1 | `[amount]` | |
| Recipient 2 | `[amount]` | |
| ... | ... | ... |
| RevenueReserveDistributor | `[reserve amount]` | Approximately 3% of total ARM supply, within this lock's 20%; fixed allocator multisig assigns irrevocable grants on-chain. |
| ... | ... | ... |

**Total must equal exactly 2,400,000 ARM.** The deployment script enforces this allocation budget; the contract stores the constructor allocation sum.

**No post-deployment modifications to RevenueLock.** Its beneficiary list and amounts remain immutable.
For the launch reserve, the list includes `RevenueReserveDistributor` as one beneficiary;
that separate contract tracks later irrevocable grants and permits sponsored payouts.
See [REVENUE_RESERVE_DISTRIBUTOR.md](REVENUE_RESERVE_DISTRIBUTOR.md) for the integration.
An exactly 3% reserve is 360,000 ARM; other direct beneficiaries collectively receive
2,040,000 ARM. This replaces the earlier off-chain Knowable Safe distribution mechanism
for the reserve. It does not assume the reserve is exclusively a team allocation.
The approximately 17%/3% split is of **total supply**, and both portions sit within
this lock's combined 20% allocation. Direct recipients retain their own release path.
The reserve multisig's unassigned fallback at wind-down must be disclosed alongside
its actual controlling parties.

---

## 5. Milestone Table

The revenue-to-unlock mapping. Immutable after deployment.

| Cumulative Revenue (USD) | Unlocked % |
|---|---|
| $0 | 0% |
| $10,000 | 10% |
| $50,000 | 25% |
| $100,000 | 40% |
| $250,000 | 60% |
| $500,000 | 80% |
| $1,000,000 | 100% |

**No interpolation.** Unlock percentage is a step function — at $49,999 revenue, unlock is 10%; at $50,000, it jumps to 25%.

**No time-based fallback.** If revenue never reaches $1M, tokens never fully unlock. There is no calendar-based override.

---

## 6. Release Mechanism

### `release(address delegatee)`

The only state-changing function a beneficiary calls.

**Preconditions:**
- `msg.sender` is a beneficiary in the list
- `delegatee != address(0)`

**Logic:**
1. Call `_updateMaxObservedRevenue()` — advances `maxObservedRevenue` and `lastSyncTimestamp` before any entitlement calculation
2. Look up the unlock percentage from the milestone table (step function, using `maxObservedRevenue`)
3. Compute entitled amount: `unlockPercentage × allocation[msg.sender]`
4. Compute releasable amount: `entitled - alreadyReleased[msg.sender]`
5. If releasable == 0: revert (nothing new to release)
6. Update `alreadyReleased[msg.sender] += releasable`
7. Call `ARM.transfer(msg.sender, releasable)` — succeeds because this contract is whitelisted
8. Call `ARM.delegateOnBehalf(msg.sender, delegatee)` — succeeds because this contract is an authorized caller

**Step 1 detail — `_updateMaxObservedRevenue()`:**
```
reported = RevenueCounter.recognizedRevenueUsd()
elapsed = block.timestamp - lastSyncTimestamp
maxAllowedIncrease = (elapsed * MAX_REVENUE_INCREASE_PER_DAY) / 1 days
capped = min(reported, maxObservedRevenue + maxAllowedIncrease)
if capped > maxObservedRevenue:
    emit ObservedRevenueUpdated(maxObservedRevenue, capped, reported)
    maxObservedRevenue = capped
lastSyncTimestamp = block.timestamp  // unconditional — always advances
```

`lastSyncTimestamp` advances on every call regardless of whether `maxObservedRevenue` changed. This is the mechanism that makes regular syncs meaningful — each sync consumes the elapsed-time allowance budget.

### `syncObservedRevenue()`

Permissionless. Calls `_updateMaxObservedRevenue()` without releasing ARM. Any address can call this. Intended for monitoring bots that keep the ratchet current without requiring a beneficiary to claim.

**Events:**
```
Released(address indexed beneficiary, uint256 amount, address delegatee, uint256 cumulativeReleased)
ObservedRevenueUpdated(uint256 oldMax, uint256 newMax, uint256 reportedByCounter)
```

`ObservedRevenueUpdated` is emitted on every actual ratchet advance (when `maxObservedRevenue` increases), by both `release()` and `syncObservedRevenue()`.

**Properties:**
- **Pull-based.** Beneficiaries call `release()` when they want. There is no push mechanism. ARM sits in the contract until claimed.
- **Atomic transfer + delegation.** Released ARM enters circulation already delegated, matching the crowdfund `claim(delegate)` pattern. No ARM enters circulation undelegated.
- **Ratchet-first.** Entitlement is always computed from `maxObservedRevenue`, never from a direct read of `RevenueCounter.recognizedRevenueUsd()`. This makes the contract immune to RevenueCounter rewind attacks.
- **Rate-limited.** `maxObservedRevenue` can only advance at `MAX_REVENUE_INCREASE_PER_DAY` per elapsed day since last sync. Acceleration requires real elapsed time.
- **Delegation applies to full balance.** Step 8 calls `delegateOnBehalf(msg.sender, delegatee)`, which sets the beneficiary's entire ARM delegation — not just the newly released tokens. This matches standard ERC20Votes behavior (one delegatee per address).
- **Idempotent.** Calling `release()` when nothing new is unlocked reverts harmlessly. Calling it multiple times between milestones is safe — `alreadyReleased` tracks cumulative releases.

---

## 7. View Functions

| Function | Returns | Notes |
|---|---|---|
| `allocation(address beneficiary)` | uint256 | Total allocation for this beneficiary |
| `released(address beneficiary)` | uint256 | Total ARM already released to this beneficiary |
| `releasable(address beneficiary)` | uint256 | ARM currently available to release. Computed against `getCappedObservedRevenue()` — the projected value `maxObservedRevenue` would advance to if `syncObservedRevenue()` were called now, mirroring what `release()` will see post-update. |
| `unlockPercentage()` | uint256 (bps) | Current unlock percentage. Computed against `getCappedObservedRevenue()` (same projected ceiling as `releasable`) so consumers see what `release()` will yield without paying for a separate sync transaction. |
| `currentRevenue()` | uint256 | Raw cumulative revenue as reported by `RevenueCounter.recognizedRevenueUsd()`. **Diagnostic only** — does NOT flow through the ratchet. Entitlement uses `maxObservedRevenue` / `getCappedObservedRevenue()`. A sustained divergence between `currentRevenue()` and `getCappedObservedRevenue()` indicates either an over-reporting RevenueCounter being rate-limited or a malicious upgrade in progress. |
| `getCappedObservedRevenue()` | uint256 | What `maxObservedRevenue` would become if `syncObservedRevenue()` were called right now. Read-only: does not modify state or advance `lastSyncTimestamp`. Use for monitoring dashboards. |
| `maxObservedRevenue` | uint256 | Current active ratchet value. Monotonically non-decreasing. |
| `lastSyncTimestamp` | uint256 | Timestamp of last `_updateMaxObservedRevenue()` call. Advances unconditionally. |
| `beneficiaryCount()` | uint256 | Number of beneficiaries |

---

## 8. What This Contract Does NOT Do

| Absent capability | Why |
|---|---|
| No admin role | Beneficiary list and milestone table are immutable |
| No `addBeneficiary()` or `removeBeneficiary()` | List is set at deployment and cannot change |
| No `reassign()` | Future contributor grants are tracked in the separate reserve distributor; this lock's beneficiary allocation stays fixed |
| No `delegate()` on behalf of unreleased tokens | Unreleased ARM sits in this contract; this contract has no delegation code path for its own balance — unreleased ARM is structurally vote-inert |
| No upgradeability | No proxy, no UUPS. Deployed bytecode is final. |
| No wind-down sweep or extra unlock | Wind-down freezes the ratchet after a final update. Entitled-but-unreleased ARM remains claimable; the still-locked portion remains permanently locked. |
| No `withdrawAll()` or sweep function | ARM can only leave via `release()` to the entitled beneficiary. No backdoor. |

---

## 9. Invariants

| Invariant | Description |
|---|---|
| **Supply conservation** | `ARM.balanceOf(this) + sum(alreadyReleased[all beneficiaries]) == totalAllocation` at all times |
| **Monotonic releases** | `alreadyReleased[beneficiary]` never decreases |
| **Milestone table is immutable** | No code path modifies the unlock schedule after deployment |
| **Beneficiary list is immutable** | No code path adds, removes, or modifies beneficiaries after deployment |
| **Unreleased ARM is vote-inert** | This contract has no `delegate()` call path for its own balance. ARM sitting here has zero voting power. |
| **Release atomically delegates** | `release()` uses `transferAndDelegate`. The reserve distributor immediately undelegates its own holdings in the same transaction and preserves recipients' existing delegation on payout. |
| **No over-release** | `alreadyReleased[beneficiary] <= allocation[beneficiary]` at all times |
| **`maxObservedRevenue` is monotonic** | `maxObservedRevenue` never decreases. RevenueCounter downgrades are invisible to this contract. |
| **`maxObservedRevenue` is rate-limited** | `maxObservedRevenue` can increase by at most `MAX_REVENUE_INCREASE_PER_DAY × elapsed_days` per call to `_updateMaxObservedRevenue()`. |
| **`lastSyncTimestamp` advances unconditionally** | Every call to `_updateMaxObservedRevenue()` (via `release()` or `syncObservedRevenue()`) updates `lastSyncTimestamp = block.timestamp`, regardless of whether `maxObservedRevenue` changed. |
| **Entitlement never reads counter directly** | No code path computes entitlement from `RevenueCounter.recognizedRevenueUsd()` directly. All entitlement calculations use `maxObservedRevenue`. |

---

## 10. Wind-Down Interaction

If `triggerWindDown()` is called on the wind-down contract:

- The authorized wind-down contract freezes the ratchet after one final update against the frozen RevenueCounter.
- ARM entitled under that frozen milestone remains claimable, including amounts not yet released. Only the unvested portion remains locked permanently.
- The separate reserve distributor permanently stops assignments. Its unassigned entitlement belongs to the allocator multisig, subject to the same frozen unlock percentage.
- Already-released ARM is in beneficiaries' wallets and is part of the "circulating" supply eligible for pro-rata treasury distribution.
- Wind-down automatically enables global ARM transfers (`setTransferable(true)`), so beneficiaries who have released ARM can move it to claim their treasury share.

**This is the intended fairness property:** those who paid (crowdfund participants) have priority in failure scenarios. Early network tokens only unlock if the protocol earns revenue — if it failed before earning revenue, those tokens stay locked and have no claim on remaining assets.

---

## 11. Custom Grants (Post-Launch)

**Two grant paths exist post-launch.** Choice is policy, not a constraint of the lock mechanism.

### 11.1 Standard treasury transfer (default)

The simple path. After governance enables global transfers, a treasury transfer via governance proposal sends ARM directly to a recipient wallet; the recipient delegates via standard `delegate()`. No lock contract, no atomic delegation, no whitelisting needed. Use this for grants that should vest immediately on disbursement.

### 11.2 Follow-on RevenueLock cohort (revenue-gated)

When a grant should vest against future protocol revenue (new teammembers, ecosystem contributors, airdrops with performance gating), governance can deploy an additional RevenueLock contract reusing the launch RevenueCounter. The `scripts/deploy_revenue_lock_cohort.ts` deploy script handles cohort deployment; a follow-up governance proposal must:

1. `armToken.addToWhitelist(cohortAddress)` — make the cohort eligible for ARM transfers in
2. `armToken.addAuthorizedDelegator(cohortAddress)` — let the cohort call `delegateOnBehalf` for atomic delegation on release
3. `treasury.distribute(armToken, cohortAddress, totalAllocation)` — fund the cohort
4. `governor.addExcludedAddress(cohortAddress)` — register the cohort's holdings as non-voteable so they don't inflate the quorum denominator

Step 4 is load-bearing: cohort ARM is held in escrow against future revenue and cannot vote, so excluding it from quorum keeps the threshold honest. `addExcludedAddress` is timelock-only (see GOVERNANCE.md).

### Implications
- The wind-down redemption denominator hardcodes the four known launch addresses (treasury, launch revenue-lock, crowdfund, redemption contract); follow-on cohorts are NOT included in the denominator. Cohort beneficiaries who have released ARM still redeem from the same denominator pool — the cohort's still-locked balance remains in circulating supply, slightly diluting redemption shares for everyone. This is accepted as the tradeoff for post-launch flexibility; cohorts are expected to be small relative to total supply.
- `delegateOnBehalf` authorization extends beyond the two launch contracts as cohorts come online. Each cohort gets its own one-shot authorization via `addAuthorizedDelegator`.

---

## 12. Deployment Checklist

| Check | Status |
|---|---|
| Expected contract addresses recorded and constructor/one-time bindings verified | ☐ |
| Beneficiary list finalized and published | ☐ |
| Total allocations sum to exactly 2,400,000 ARM | ☐ |
| Milestone table matches GOVERNANCE.md | ☐ |
| RevenueCounter proxy deployed at expected address | ☐ |
| RevenueLock deployed at expected address with correct constructor parameters (including `MAX_REVENUE_INCREASE_PER_DAY`) | ☐ |
| `RevenueLock.lastSyncTimestamp` correctly initialized to deploy `block.timestamp` (NOT 0) | ☐ |
| `RevenueLock.maxObservedRevenue` initialized to 0 (NOT seeded from RevenueCounter) | ☐ |
| ARM token deployed — constructor mints entire 12M supply to bootstrap holder (deployment multisig) | ☐ |
| Token whitelist initialized with RevenueLock and reserve distributor | ☐ |
| Token delegators initialized with RevenueLock; reserve is not an authorized delegator or in `noDelegation` | ☐ |
| Reserve bound; token initialization complete; quorum exclusions and wind-down wiring verified; pre-funding gate passes | ☐ |
| Distribution transaction executed: 2.4M ARM to RevenueLock, 1.8M ARM to Crowdfund, 7.8M ARM to Treasury | ☐ |
| Post-distribution: `RevenueLock` balance == 2,400,000 ARM exactly | ☐ |
| Post-distribution: `Crowdfund` balance == 1,800,000 ARM exactly | ☐ |
| Post-distribution: `Treasury` balance == 7,800,000 ARM exactly | ☐ |
| Post-distribution: bootstrap holder balance == 0 ARM exactly | ☐ |
| Post-distribution: bootstrap holder has no remaining ARM allowances in any protocol contract | ☐ |
| Post-distribution: bootstrap holder removed from the whitelist using its one-time removal function | ☐ |
| `ARM.totalSupply()` == 12,000,000 × 10^18 (independent supply check) | ☐ |
| `release()` tested on testnet with mocked revenue counter | ☐ |
| `syncObservedRevenue()` tested on testnet — confirmed `lastSyncTimestamp` advances on every call regardless of whether `maxObservedRevenue` changed | ☐ |
| `getCappedObservedRevenue()` view function tested — returns consistent values with state-modifying path | ☐ |
| Monitoring bot for `syncObservedRevenue()` deployed and running at least daily | ☐ |
| Protocol declared "live" ONLY after all verification checks above pass | ☐ |

---

## 13. Dependency Map

```
RevenueLock
  ├── reads: RevenueCounter.recognizedRevenueUsd() — via _updateMaxObservedRevenue() ratchet only
  │           (never reads counter directly for entitlement; ratchet enforces monotonic + rate-limited view)
  ├── stores: maxObservedRevenue, lastSyncTimestamp, MAX_REVENUE_INCREASE_PER_DAY
  ├── calls: ARM.transfer(beneficiary, amount) (whitelisted sender)
  ├── calls: ARM.delegateOnBehalf(beneficiary, delegatee) (authorized caller)
  ├── exposes: syncObservedRevenue() — permissionless, called by monitoring bots at least daily
  ├── exposes: getCappedObservedRevenue() — read-only view for monitoring dashboards
  ├── consumed by: Monitoring (reads Released, ObservedRevenueUpdated events)
  └── consumed by: ARM_TOKEN.md §6.2 (voting enforcement architecture)

RevenueCounter (separate contract, UUPS proxy)
  ├── emits: RevenueUpdated(cumulativeRevenue, previousRevenue)
  ├── consumed by: RevenueLock via ratchet (not direct read for entitlement)
  └── consumed by: Monitoring (reads RevenueUpdated events)
```
