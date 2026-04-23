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
| Treasury | `[TBD]` | Immutable (constructor) | ☐ | Receives net USDC proceeds + swept ARM. Must be multisig. |
| ROOT / Launch team | `[TBD]` | Immutable (constructor) | ☐ | Calls `addSeed()`, `launchTeamInvite()`. Must be multisig. |
| Security Council | `[TBD]` | Immutable (constructor) | ☐ | Calls `cancel()`. 3-of-5 multisig. |
| ARM token | `[TBD]` | Immutable (constructor) | ☐ | 18 decimals. Verify against official deployment. |
| USDC token | `[TBD — exact contract address for target chain]` | Immutable (constructor) | ☐ | 6 decimals. Must be the exact USDC contract address on the deployment chain — not a human label. Verify against Circle's official deployment list: https://developers.circle.com/stablecoins/docs/usdc-on-main-networks |

**All addresses are immutable post-deployment.** There is no admin function to change any address after the contract is deployed.

---

## 2. Timestamps

| Parameter | Human-readable | Unix timestamp | Mutability | Verified | Notes |
|---|---|---|---|---|---|
| Open timestamp | `[TBD: date/time UTC]` | `[TBD]` | Immutable (constructor) | ☐ | Commitment window, hop-0 additions, and invites begin here |
| Week-1 deadline | Open + 7 days | `[TBD]` | Immutable (constructor) | ☐ | `addSeed()` and `launchTeamInvite()` revert after this |
| Commitment deadline | Open + 21 days | `[TBD]` | Immutable (constructor) | ☐ | `commit()`, `commitWithInvite()`, `invite()` revert after this |
| Claim deadline | Finalization + 3 years | Computed at finalization | Immutable (derived) | — | `claim()` permitted when `block.timestamp <= finalizationTimestamp + 94_608_000`. Sweep eligible at `>`. |

**Timestamp verification:** Convert each unix timestamp back to human-readable and confirm date, time, and timezone match intent. Verify `week1Deadline == openTimestamp + 604_800` (7 × 86400). Verify `commitmentDeadline == openTimestamp + 1_814_400` (21 × 86400).

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
| HOP_CEILING_BPS | 7000 (70% of available) | 4500 (45% of available) | — (no enforced ceiling) | Immutable (constant) |
| HOP2_FLOOR_BPS | — | — | 500 (5% of sale_size) | Immutable (constant) |
| Outgoing invite slots per slot | 3 | 2 | 0 | Immutable (constant) |
| Slot source | `SeedAdded` | `Invited` | `Invited` | — |

**Cap formula:** Per-address cap at hop = `participation_slots[(address, hop)] × HOP_CAP[hop]`

**Ceiling amounts at base ($1.2M):** hop-2 floor = $60k; available = $1.14M; hop-0 ceiling = $798k; hop-1 ceiling = $513k
**Ceiling amounts at expanded ($1.8M):** hop-2 floor = $90k; available = $1.71M; hop-0 ceiling = $1,197k; hop-1 ceiling = $769.5k

---

## 5. Budgets

| Parameter | Value | Mutability | Verified | Notes |
|---|---|---|---|---|
| Hop-0 budget | 160 | Immutable (constant) | ☐ | Max `addSeed()` calls |
| Launch-team hop-1 budget | 60 | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 0)` calls |
| Launch-team hop-2 budget | 60 | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 1)` calls |
| Max network size | ~1,840 nodes | Derived | — | 160 + 540 + 1,140 (see CROWDFUND.md) |

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

## 8. Governance Parameters (reference only — not crowdfund constructor inputs)

These values are defined in GOVERNANCE.md and affect the ARM token / governor contracts, not the crowdfund contract itself. They are included here for cross-reference only. Do not use this section as a constructor argument source.

| Parameter | Value | Source | Notes |
|---|---|---|---|
| Quiet period | 7 days post-finalization | GOVERNANCE.md | No proposals until day 8 |
| Claim deadline | 3 years (94,608,000 seconds) | CROWDFUND.md §Finalization | Fixed term — but the crowdfund contract derives this from `finalizationTimestamp`, not a constructor arg |
| Proposal threshold | 5,000 ARM | GOVERNANCE.md | |
| Quorum | max(20% circulating, 100,000 ARM) | GOVERNANCE.md | |
| `LIMIT_ACTIVATION_DELAY` | 24 days (2,073,600 seconds) | GOVERNANCE.md §Treasury Outflow Limits | Hardcoded constant in `ArmadaTreasuryGov`. Not governance-settable. Constrained by `_maxExtendedCycle() < LIMIT_ACTIVATION_DELAY` — governor timing setters revert if they would violate this invariant. |
| `MAX_REVENUE_INCREASE_PER_DAY` | 10,000 × 10^6 (= $10,000 USDC/day) | REVENUE_LOCK.md §6, ARM_TOKEN.md §5.1 | Immutable, set at deployment in RevenueLock constructor. Not governance-settable. Calibrated to require minimum 100 days for malicious $0 → $1M full-unlock acceleration under captured governance, assuming `syncObservedRevenue()` is called at least daily. Defensive security calibration, not steady-state economic parameter. Effective rate cap depends on regular sync calls; without regular syncs, the cap accumulates over idle periods. |

---

## 9. Settlement Mode

| Parameter | Value | Verified | Notes |
|---|---|---|---|
| Settlement mode | Lazy settlement | ✓ | `finalize()` writes aggregate state only; `Allocated` + `AllocatedHop` emitted at individual `claim()` time. No `emitSettlement()`, no `SettlementComplete`. |
| Gas estimate at max network | `[TBD]` gas | ☐ | From IMPLEMENTATION_TEST.md S16 fixture |
| Block gas limit target | 30,000,000 | — | Current mainnet limit |

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
- ROOT: `addSeed()`, `launchTeamInvite()` — week 1 only
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
| All timestamps independently converted and verified | ☐ | |
| All decimal-encoded values independently computed and verified | ☐ | |
| EIP-712 domain fields confirmed | ☐ | |
| Token decimals verified on-chain | ☐ | |
| Settlement mode confirmed from gas testing | ☐ | |
| OPERATIONS.md §2 checklist matches this manifest exactly | ☐ | |
| MONITORING.md alert thresholds reference these values | ☐ | |
| Two independent reviewers have signed off on all values | ☐ | |

**Once all items are checked, this document is frozen. No changes without re-running the full checklist.**
