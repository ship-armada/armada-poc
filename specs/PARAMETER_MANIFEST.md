# Armada Crowdfund — Parameter Manifest & Launch Freeze Sheet

## Purpose

Single source of truth for every concrete value that enters the deployed contract. Referenced by CROWDFUND.md (mechanism), OPERATIONS.md (deployment), MONITORING.md (alerting), IMPLEMENTATION_TEST.md (test harness), and the eventual audit package.

**Every value in this document must be confirmed before deployment. No other document overrides this one for deployment-time values.**

---

## How to use this document

1. **Before deployment:** Fill in every `[TBD]` field. Two people independently verify each value. Sign off in the Verified column.
2. **At deployment:** Use this document as the constructor argument source. Do not copy values from any other doc.
3. **After deployment:** Record the contract address and deployment tx. This document becomes the permanent deployment record.
4. **For auditors:** This is the parameter reference. Every constant in the contract should trace back to a row in this document.

---

## 1. Addresses

| Parameter | Value | Mutability | Verified | Notes |
|---|---|---|---|---|
| Crowdfund contract | `[TBD — set at deployment]` | Immutable | ☐ | Record after deploy |
| Treasury | `[TBD]` | Immutable (constructor) | ☐ | Receives net USDC proceeds + swept ARM. `ArmadaTreasuryGov`, deployed by the launch and controlled by governance through the timelock (not a multisig). |
| ROOT / Launch team | `[TBD]` | Immutable (constructor) | ☐ | Calls `addSeed()`, `launchTeamInvite()`. 2-of-3 Safe (checked at deploy). The same `LAUNCH_TEAM_ADDRESS` is the `UpgradeGate` approver: every governance proposal that upgrades a contract or authorizes an ARM delegator needs this Safe's approval to execute (GOVERNANCE.md §Launch Team upgrade gate). The gate's team can be rotated later only by the team itself (two-step handover). |
| Security Council | `[TBD]` | Immutable (constructor) | ☐ | Calls `cancel()`. 2-of-3 multisig. |
| ARM token | `[TBD]` | Immutable (constructor) | ☐ | 18 decimals. Verify against official deployment. |
| USDC token | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (Ethereum mainnet) | Immutable (constructor) | ☐ | `HUB_USDC` in `config/mainnet.env`; on-chain: 6 decimals, symbol `USDC`, `isMinter(TokenMinterV2)` true. 6 decimals. Must be the exact USDC contract address on the deployment chain — not a human label. Verify against Circle's official deployment list: https://developers.circle.com/stablecoins/docs/usdc-on-main-networks |
| CCTP V2 TokenMessengerV2 / MessageTransmitterV2 / TokenMinterV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` / `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` / `0xfd78EE919681417d192449715b2594ab58f5D002` | Not a crowdfund constructor input — recorded in the hub CCTP manifest by deploy step 1 and reused by the shielded-pool launch | ☐ | Same address on Ethereum, Base, Arbitrum. `CCTP_*` in `config/mainnet.env`; step 1 fails without them (#535). Verify against https://developers.circle.com/cctp/evm-smart-contracts and on-chain (`localDomain`, messenger ↔ transmitter ↔ minter links, `USDC.isMinter(TokenMinterV2)`). |

**All crowdfund addresses are immutable post-deployment.** There is no admin function to change any address after the contract is deployed.

---

## 2. Timestamps

| Parameter | Human-readable | Unix timestamp | Mutability | Verified | Notes |
|---|---|---|---|---|---|
| Open timestamp | `[TBD: date/time UTC]` | `[TBD]` | Immutable (constructor) | ☐ | Commitment window, hop-0 additions, and invites begin here. Set as `CROWDFUND_OPEN_TIME` (ISO 8601 UTC, e.g. `2026-10-08T17:00:00Z`) in `config/mainnet.env` — required on mainnet; `setup:mainnet` refuses to start unless it is 1h–60d away (#543). |
| Launch-team invite deadline | Open + 21 days (equals the commitment deadline) | `[TBD]` | Immutable (constructor) | ☐ | `addSeed()` and `launchTeamInvite()` revert at and after this (strict `<`; participant actions stay open for that final second) |
| Commitment deadline | Open + 21 days | `[TBD]` | Immutable (constructor) | ☐ | `commit()`, `commitWithInvite()`, `invite()` revert after this |
| Claim deadline | Finalization + 3 years | Computed at finalization | Immutable (derived) | — | `claim()` permitted when `block.timestamp <= finalizationTimestamp + 94_608_000`. Sweep eligible at `>`. |

**Timestamp verification:** Convert each unix timestamp back to human-readable and confirm date, time, and timezone match intent. Verify `launchTeamInviteDeadline == openTimestamp + 1_209_600` (14 × 86400). Verify `commitmentDeadline == openTimestamp + 1_814_400` (21 × 86400).

**3-year duration:** Exactly `94_608_000 seconds` (1,095 days = 3 × 365 days). This is a fixed second count, not 3 calendar years — does not account for leap years.

---

## 3. Sale Economics

| Parameter | Human-readable | Contract value | Unit | Mutability | Verified |
|---|---|---|---|---|---|
| BASE_SALE | 1,200,000 ARM | `1_200_000_000_000_000_000_000_000` | ARM (18 dec) | Immutable (constant) | ☐ |
| MAX_SALE | 1,800,000 ARM | `1_800_000_000_000_000_000_000_000` | ARM (18 dec) | Immutable (constant) | ☐ |
| MINIMUM_RAISE | $1,000,000 USDC | `1_000_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| EXPANSION_TRIGGER | $1,500,000 USDC capped demand | `1_500_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| PRICE | $1.00 per ARM | 1e6 USDC per 1e18 ARM | Ratio | Immutable (constant) | ☐ |
| TOTAL_SUPPLY | 12,000,000 ARM | `12_000_000_000_000_000_000_000_000` | ARM (18 dec) | — | Reference only (not in crowdfund contract) |

**Decimal conversion rules:**
- ARM amounts: multiply human-readable by `10^18`
- USDC amounts: multiply human-readable by `10^6`
- Price ratio: `1_000_000` USDC-units per `1_000_000_000_000_000_000` ARM-units

---

## 4. Hop Structure

| Parameter | Hop-0 | Hop-1 | Hop-2 | Mutability |
|---|---|---|---|---|
| HOP_CAP (per slot) | $15,000 (`15_000_000_000` USDC) | $4,000 (`4_000_000_000` USDC) | $1,000 (`1_000_000_000` USDC) | Immutable (constant) |
| HOP_CEILING_BPS | 6000 (60% of base pool, then less extra floor) | 4500 (45% of base pool) | — (no enforced ceiling) | Immutable (constant) |
| HOP2_BASE_FLOOR_BPS | — | — | 500 (5% of sale_size) | Immutable (constant) |
| HOP2_EXTRA_FLOOR_BPS | — | — | 1000 (additional 10% of sale_size) | Immutable (constant) |
| Outgoing invite slots per slot (`maxInvites`) | 3 | 2 | 0 | Immutable (constant) |
| Incoming invite stacking cap (`maxInvitesReceived`) | 1 | 10 | 20 | Immutable (constant) |
| Slot source | `SeedAdded` | `Invited` | `Invited` | — |

**Cap formula:** Per-address cap at hop = `participation_slots[(address, hop)] × HOP_CAP[hop]`

**Stacking cap semantics:** `maxInvitesReceived` bounds how many inbound invite edges a single (address, hop) node can accept. Hop-0 cannot stack at all — its only inviter is the launchTeam sentinel via `addSeed`. Hop-1 nodes can stack up to 10× (each accepted invite increments `invitesReceived`, scaling both their effective USDC cap and their outgoing invite budget). Hop-2 nodes can stack up to 20×. The cap is enforced inside `invite()` / `commitWithInvite()` — re-inviting a node already at its stacking cap reverts.

**Commitment floor (`MIN_COMMIT`):** `10 USDC` (`10_000_000` USDC, 6 decimals). Both `commit()` and `commitWithInvite()` revert with `amount < MIN_COMMIT`. Immutable (constant). Sized to keep dust commits out of the participant graph — every commit registers a `participantNode`, and the rounding buffer at finalization is bounded by `participantNodes.length`. Not enforced as a percentage of cap.

**Ceiling amounts at base ($1.2M):** base pool = $1.14M; hop-2 floor = $180k; available = $1.02M; hop-0 ceiling = $564k; hop-1 raw ceiling = $513k and can rise to $1.02M with all hop-0 capacity rolled forward.
**Ceiling amounts at expanded ($1.8M):** base pool = $1.71M; hop-2 floor = $270k; available = $1.53M; hop-0 ceiling = $846k; hop-1 raw ceiling = $769.5k and can rise to $1.53M with all hop-0 capacity rolled forward.

---

## 5. Budgets

| Parameter | Value | Mutability | Verified | Notes |
|---|---|---|---|---|
| Hop-0 budget | 180 | Immutable (constant) | ☐ | Max `addSeed()` calls |
| Launch-team hop-1 budget | 100 | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 0)` calls |
| Launch-team hop-2 budget | 120 | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 1)` calls |
| `MAX_FINALIZE_NODES` | 1,800 | Immutable (constant) | ☐ | Hard cap on total `participantNodes`, enforced in `_initParticipant`. Keeps one-shot `finalize()` (~8,200 gas/node cold, ~15.2M at 1,800) under the **16,777,216 (2^24, EIP-7825) per-tx gas cap**. Node creation reverts `"node cap reached"` beyond it. |
| Structural max network size | 2,220 nodes | Derived | — | 180 + 640 + 1,400 — but `MAX_FINALIZE_NODES` (1,800) binds first, so 2,220 is not reachable (see CROWDFUND.md) |

---

## 6. EIP-712 Domain

| Field | Value | Mutability | Verified |
|---|---|---|---|
| `name` | `"ArmadaCrowdfund"` | Immutable (constant) | ☐ |
| `version` | `"1"` | Immutable (constant) | ☐ |
| `chainId` | `[TBD]` | Implementation-dependent: stored in constructor state OR derived from `block.chainid` at verification time. Verify which model the implementation uses and record here. | ☐ |
| `verifyingContract` | `[TBD — set at deployment]` | Immutable (derived) | ☐ — verify post-deploy via `DOMAIN_SEPARATOR()` |

**Post-deploy verification:** Call `DOMAIN_SEPARATOR()` and compare against locally computed `keccak256(abi.encode(DOMAIN_TYPEHASH, nameHash, versionHash, chainId, contractAddress))`. If mismatch: do NOT proceed. Redeploy.

---

## 7. Invite Link Parameters

| Parameter | Value | Mutability | Notes |
|---|---|---|---|
| Default link expiry | 5 days (432,000 seconds) | UI default (not enforced by contract) | `deadline` in EIP-712 payload. Contract checks `block.timestamp <= deadline`. |
| Nonce range | Any `uint256 > 0` | Contract-enforced | Nonce 0 reserved for direct invites. `commitWithInvite()` requires `nonce > 0`. `revokeInviteNonce(0)` reverts. |
| Signature verification | `SignatureChecker.isValidSignatureNow()` | Contract-enforced | Supports EOA (ecrecover) + EIP-1271 (smart contract wallets) |

---

## 8. Governance & RevenueLock Parameters

### 8.1 Reference values (not constructor inputs)

These values are defined in GOVERNANCE.md and affect the ARM token / governor contracts, not the crowdfund contract itself. They are included here for cross-reference only. Do not use this subsection as a constructor argument source.

| Parameter | Value | Source | Notes |
|---|---|---|---|
| Quiet period | 7 days post-finalization | GOVERNANCE.md | No proposals until day 8 |
| Claim deadline | 3 years (94,608,000 seconds) | CROWDFUND.md §Finalization | Fixed term — but the crowdfund contract derives this from `finalizationTimestamp`, not a constructor arg |
| Proposal threshold | 5,000 ARM | GOVERNANCE.md | |
| Quorum | max(20% circulating, 100,000 ARM) | GOVERNANCE.md | |
| `LIMIT_ACTIVATION_DELAY` | 24 days (2,073,600 seconds) | GOVERNANCE.md §Treasury Outflow Limits | Hardcoded constant in `ArmadaTreasuryGov`. Not governance-settable. Constrained by `_maxExtendedCycle() < LIMIT_ACTIVATION_DELAY` — governor timing setters revert if they would violate this invariant. |

### 8.2 Deploy inputs — freeze before deploy

Unlike §8.1, these **are** deployment inputs for the governance / RevenueLock deploy (independent of the crowdfund constructor). They are immutable or protection-critical once set and must be finalized and two-person verified before deploy. Source of record: `config/networks.ts` (mainnet) → this sheet. This subsection is the single freeze location for these values — the tracking issues below should reference it rather than re-listing values.

| Parameter | Value | Mutability | Verified | Notes / tracking |
|---|---|---|---|---|
| RevenueLock beneficiary list | `[TBD — finalized (address, amount) JSON]` | Immutable (RevenueLock constructor) | ☐ | Must sum **exactly** to 2,400,000 × 10^18 ARM (1,800,000 team + 600,000 airdrop). Loaded via `REVENUE_LOCK_BENEFICIARIES_FILE`; deploy rejects Anvil placeholders on non-local. Tracking: #144. The schedule must identify the reserve distributor and separately reviewed airdrop distributor, reconcile categories with the approved cap table, and persist original constructor ordering; individual airdrop recipients are not assumed to be direct entries. |
| Reserve cap | `[TBD — approved cap-table amount]` | Immutable (distributor constructor) | ☐ | Within the 2,400,000 ARM lock budget; 360,000 ARM / 3% is a worked example only. Reconcile the reported 120,000 ARM / 1% cap-table reserve before launch; this PR does not change category ownership. |
| Reserve allocator | `[TBD — independently verified Safe]` | Immutable (distributor constructor) | ☐ | Exactly three identified owners, threshold two; confirm chain/address, implementation, modules, guard, fallback handler, quorum eligibility and absence from `noDelegation`. |
| Treasury outflow limit — USDC | 30-day window; max($100,000, 10% of treasury USDC); floor $50,000 (`2592000`, `1000` bps, `100000000000`, `50000000000`) | Set at deploy (timelock `initOutflowConfig`); governance-adjustable after, floor can only be raised | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_USDC_*` in `config/mainnet.env`. Tracking: #348. |
| Treasury outflow limit — ARM | 30-day window; max(250,000 ARM, 3% of treasury ARM); floor 100,000 ARM (`2592000`, `300` bps, `250000e18`, `100000e18`) | Set at deploy (timelock `initOutflowConfig`); governance-adjustable after, floor can only be raised | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_ARM_*` in `config/mainnet.env`. Tracking: #348. |
| Treasury outflow limit — ETH (`address(0)`) | 30-day window; max(25 ETH, 10% of treasury ETH); no floor (`2592000`, `1000` bps, `25e18`, `0`) | Set at deploy (timelock `initOutflowConfig`); governance-adjustable after, floor can only be raised | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_ETH_*` in `config/mainnet.env`. Tracking: #348. |
| RevenueLock `MAX_REVENUE_INCREASE_PER_DAY` | $10,000/day = 10,000 × 10^18 (`10000000000000000000000`, 18-decimal USD) | Immutable (RevenueLock constructor); not governance-settable | ☐ | 18-decimal USD to match `RevenueCounter.recognizedRevenueUsd` — **not** 6-decimal USDC; a 10^6 value would cap the ratchet at $0.00000001/day and lock beneficiaries out permanently. Calibrated (issue #225) to require minimum 100 days for malicious $0 → $1M full-unlock acceleration under captured governance, assuming `syncObservedRevenue()` is called at least daily. Defensive security calibration, not steady-state economic parameter. Effective rate cap depends on regular sync calls; without regular syncs, the cap accumulates over idle periods (start the daily sync on deploy day). `REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD` (whole USD) in `config/mainnet.env`; config rejects non-integers and values above $1,000,000. Also applies to later cohorts (`deploy_revenue_lock_cohort.ts`). Source: REVENUE_LOCK.md §6, ARM_TOKEN.md §5.1. Tracking: #530. |
| Wind-down revenue threshold | $10,000 cumulative = 10,000 × 10^18 (`10000000000000000000000`, 18-decimal USD; set in whole USD as `WINDDOWN_REVENUE_THRESHOLD=10000`) | Set at deploy (ArmadaWindDown constructor); governance-adjustable pre-trigger (`setRevenueThreshold`) | ☐ | Below-threshold recognized revenue at the deadline makes wind-down **permissionlessly triggerable**. Recognized revenue only advances via the Launch 2 fee module — set with a Launch 2 schedule buffer so the pool has time to ship. Value per GOVERNANCE.md / CROWDFUND.md §Wind-Down. `WINDDOWN_REVENUE_THRESHOLD` is **required** on mainnet (no default in `config/networks.ts`). Tracking: #381 (feasibility C2). |
| Wind-down deadline | `2027-12-31T00:00:00Z` (unix `1830211200`) | Set at deploy (ArmadaWindDown constructor); governance-adjustable pre-trigger (`setWindDownDeadline`) | ☐ | The date the permissionless trigger arms if revenue is under threshold. Must leave headroom for the Launch 2 (shielded pool) deploy + fee revenue ramp; governance is expected to retarget it to ~6 months after Launch 2 once that date is known (CROWDFUND.md §Wind-Down). `WINDDOWN_DEADLINE` is **required** on mainnet (no default in `config/networks.ts`). Tracking: #381 (feasibility C2). |
| Initial Treasury Steward | `[TBD — independently verified Safe]` | Set at deploy (timelock `electSteward`); 180-day term from the deploy block; re-election Extended, removal Standard | ☐ | `INITIAL_STEWARD_ADDRESS` in `config/mainnet.env` — **required** on mainnet (no default). Exactly three identified owners, threshold two (checked on-chain before the first transaction, as for the reserve allocator); must differ from the deployer, Security Council, launch team and reserve allocator. Confirm chain/address, implementation, modules, guard and fallback handler. Tracking: #221. |
| USDC steward budget | $60,000 per rolling 30 days (`60000` whole USD → `60000000000` at 6dp, `2592000`) | Set at deploy (timelock `addStewardBudgetToken`); increase / extend Extended, decrease / remove Standard | ☐ | From GOVERNANCE.md §Treasury Steward. `STEWARD_BUDGET_USDC` (whole USD; config rejects values above the USDC outflow absolute limit) and `STEWARD_BUDGET_WINDOW` in `config/mainnet.env`; the deploy refuses a hub USDC that does not report 6 decimals. Accepted launch-window exposure: GOVERNANCE.md §Election. Tracking: #222. |

---

## 9. Settlement Mode

| Parameter | Value | Verified | Notes |
|---|---|---|---|
| Settlement mode | Lazy settlement | ✓ | `finalize()` writes aggregate state only; `Allocated` + `AllocatedHop` emitted at individual `claim()` time. No `emitSettlement()`, no `SettlementComplete`. |
| Gas estimate at max network | `[TBD]` gas | ☐ | From IMPLEMENTATION_TEST.md S16 fixture |
| Per-tx gas cap | 16,777,216 (2^24) | — | EIP-7825 single-tx cap — the binding limit for `finalize()`; the block gas limit (~30M+) is not |

---

## 10. Token Decimals Cross-Check

| Token | Expected decimals | Verified on-chain | Contract address verified |
|---|---|---|---|
| ARM | 18 | ☐ | ☐ |
| USDC | 6 | ☐ | ☐ |

**Why this matters:** Every economic value in this document uses a specific decimal encoding. If the actual token has different decimals, every value is wrong. Verify on-chain before deployment.

---

## 11. Deployment Record

Fill after deployment. This section is the permanent record.

| Field | Value |
|---|---|
| Contract address | `[fill after deploy]` |
| Deploy TX hash | `[fill after deploy]` |
| Deploy block number | `[fill after deploy]` |
| Deployer address | `[fill after deploy]` |
| `loadArm()` TX hash | `[fill after deploy]` |
| `DOMAIN_SEPARATOR()` verified | ☐ |
| ARM balance verified (1,800,000e18) | ☐ |
| Observer confirmed operational | ☐ |
| Committer confirmed operational | ☐ |
| Settlement mode confirmed | Lazy settlement |

---

## 12. Mutability Summary

Every parameter in this contract falls into one of three categories:

| Category | Meaning | Examples |
|---|---|---|
| **Immutable (constant)** | Hardcoded in contract bytecode. Cannot change after compilation. | BASE_SALE, MAX_SALE, HOP_CAP, HOP_CEILING_BPS, hop-0 budget, invite limits |
| **Immutable (constructor)** | Set once at deployment via constructor args. Cannot change after deployment. | Treasury address, ROOT address, Security Council address, timestamps, chainId |
| **Immutable (derived)** | Computed at deployment or finalization from other immutables. Cannot change. | DOMAIN_SEPARATOR, claim deadline (finalizationTimestamp + 3 years) |

**There are no admin-mutable parameters in the crowdfund contract.** No address can change any parameter after deployment. This is intentional — the mechanism is fully predeclared.

The only role-gated *actions* are:
- ROOT: `addSeed()`, `launchTeamInvite()` — days 1-21 only (the full commitment window)
- Security Council: `cancel()` — pre-finalization only

Neither of these changes a parameter. They execute predeclared actions within predeclared budgets.

---

## 13. Cross-Document Reference

This manifest is referenced by:

| Document | What it uses from here |
|---|---|
| CROWDFUND.md | All economic constants; hop structure; timing |
| OPERATIONS.md | Constructor params checklist (§2); deployment record |
| MONITORING.md | Alert thresholds; timestamp boundaries; budget caps |
| IMPLEMENTATION_TEST.md | Test harness constants; gas fixture parameters |
| CROWDFUND_REVIEW_BRIEF.md | Key parameters block; pressure-test values |
| CROWDFUND_OBSERVER.md | Hop caps for display; budget totals |
| CROWDFUND_COMMITTER.md | Hop caps for eligibility display; link expiry default |

---

## 14. Freeze Checklist

Before deployment, every row must be verified. This is the final sign-off.

| Check | Status | Signer |
|---|---|---|
| All `[TBD]` fields filled | ☐ | |
| All addresses confirmed by counterparty (treasury, ROOT, SC members) | ☐ | |
| RevenueLock beneficiary list finalized and sums to 2,400,000e18 (§8.2, #144) | ☐ | |
| Treasury outflow limits finalized — USDC/ARM/ETH (§8.2, #348) | ☐ | |
| Wind-down threshold + deadline set with Launch 2 schedule buffer (§8.2, #381 C2) | ☐ | |
| All timestamps independently converted and verified | ☐ | |
| All decimal-encoded values independently computed and verified | ☐ | |
| EIP-712 domain fields confirmed | ☐ | |
| Token decimals verified on-chain | ☐ | |
| Settlement mode confirmed from gas testing | ☐ | |
| OPERATIONS.md §2 checklist matches this manifest exactly | ☐ | |
| MONITORING.md alert thresholds reference these values | ☐ | |
| Two independent reviewers have signed off on all values | ☐ | |

**Once all items are checked, this document is frozen. No changes without re-running the full checklist.**
