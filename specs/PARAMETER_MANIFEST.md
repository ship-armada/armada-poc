# Armada Crowdfund — Parameter Manifest & Launch Freeze Sheet

## Purpose

Single source of truth for every concrete value that enters the deployed contract. Referenced by CROWDFUND.md (mechanism), OPERATIONS.md (deployment), MONITORING.md (alerting), and the eventual audit package.

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
| Treasury | `[TBD]` | Immutable (constructor) | ☐ | Receives net USDC proceeds (after the $250,000 team payment) + swept ARM. `ArmadaTreasuryGov`, deployed by the launch and controlled by governance through the timelock (not a multisig). |
| ROOT / Launch team | `0xB81B908219F93976f522df3DB9083B46045983E5` (`LAUNCH_TEAM_ADDRESS`) | Immutable (constructor) | ☐ | Calls `addSeed()`, `launchTeamInvite()`, `extendWindow()`. Receives the `TEAM_PAYMENT_USDC` ($250,000) team payment on a successful finalize (`LaunchTeamPaid`). 1-of-3 Safe, every signer on a hardware wallet (deploy checks three owners, threshold one or two). Must differ from the Security Council (checked at deploy). |
| Security Council | `0x6F55B92B40c3F3cE41c50b50f4AD3a41D37B6D3f` (`SECURITY_COUNCIL_ADDRESS`) | Immutable (constructor) | ☐ | Calls `cancel()`. 2-of-3 multisig. Must differ from the launch team (checked at deploy). |
| ARM token | `[TBD]` | Immutable (constructor) | ☐ | 18 decimals. Verify against official deployment. |
| USDC token | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (Ethereum mainnet) | Immutable (constructor) | ☐ | `HUB_USDC` in `config/mainnet.env`; on-chain: 6 decimals, symbol `USDC`, `isMinter(TokenMinterV2)` true. 6 decimals. Must be the exact USDC contract address on the deployment chain — not a human label. Verify against Circle's official deployment list: https://developers.circle.com/stablecoins/docs/usdc-on-main-networks |
| CCTP V2 TokenMessengerV2 / MessageTransmitterV2 / TokenMinterV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` / `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` / `0xfd78EE919681417d192449715b2594ab58f5D002` | Not a crowdfund constructor input — recorded in the hub CCTP manifest by deploy step 1 and reused by the shielded-pool launch | ☐ | Same address on Ethereum, Base, Arbitrum. `CCTP_*` in `config/mainnet.env`; step 1 fails without them (#535). Verify against https://developers.circle.com/cctp/evm-smart-contracts and on-chain (`localDomain`, messenger ↔ transmitter ↔ minter links, `USDC.isMinter(TokenMinterV2)`). |

**All crowdfund addresses are immutable post-deployment.** There is no admin function to change any address after the contract is deployed.

---

## 2. Timestamps

| Parameter | Human-readable | Unix timestamp | Mutability | Verified | Notes |
|---|---|---|---|---|---|
| Open timestamp | `2026-12-01T16:00:00Z` (Tue 1 Dec 2026, 16:00 UTC) | `1796140800` | Immutable (constructor) | ☐ | Commitment window, hop-0 additions, and invites begin here. Set as `CROWDFUND_OPEN_TIME` (ISO 8601 UTC, e.g. `2026-10-08T17:00:00Z`) in `config/mainnet.env` — required on mainnet; `setup:mainnet` refuses to start unless it is 6h–60d away (`CROWDFUND_OPEN_MIN_LEAD_SECONDS` / `CROWDFUND_OPEN_MAX_LEAD_SECONDS` in `scripts/deploy-utils.ts`). The 6h minimum can be shortened with the `CROWDFUND_OPEN_MIN_LEAD_SECONDS` env var (hard floor 1h); `config/mainnet.env` leaves it unset. |
| Launch-team invite deadline | Open + 5 days (equals the commitment deadline): `2026-12-06T16:00:00Z` | `1796572800` | Constructor; launch team can extend (with the commitment deadline) | ☐ | `addSeed()` and `launchTeamInvite()` revert at and after this (strict `<`; participant actions stay open for that final second). `extendWindow()` moves it together with the commitment deadline |
| Commitment deadline | Open + 5 days (`WINDOW_DURATION`): `2026-12-06T16:00:00Z` | `1796572800` | Constructor; launch team can extend, only later, up to the maximum window | ☐ | `commit()`, `commitWithInvite()`, `invite()` revert after this. `extendWindow()` can move it later while the window is open |
| Maximum window | Open + `MAX_WINDOW_DURATION` (15 days) | Derived from open timestamp | Immutable (constant) | ☐ | Hard cap for `extendWindow()`; bounds participants' USDC lock-up. Operational rule (not enforced beyond the cap): extend in +5-day steps, at most twice |
| Claim deadline | Finalization + 3 years | Computed at finalization | Immutable (derived) | — | `claim()` permitted when `block.timestamp <= finalizationTimestamp + 94_608_000`. Sweep eligible at `>`. |

**Timestamp verification:** Convert each unix timestamp back to human-readable and confirm date, time, and timezone match intent. Verify `launchTeamInviteEnd() == windowStart() + 432_000` (5 × 86400). Verify `windowEnd() == windowStart() + 432_000` — the two deadlines are equal. These hold at deploy; after any `extendWindow()` call both deadlines equal the latest `WindowExtended.newEnd`.

**3-year duration:** Exactly `94_608_000 seconds` (1,095 days = 3 × 365 days). This is a fixed second count, not 3 calendar years — does not account for leap years.

---

## 3. Sale Economics

| Parameter | Human-readable | Contract value | Unit | Mutability | Verified |
|---|---|---|---|---|---|
| BASE_SALE | $1,800,000 USDC (= 1,800,000 ARM at $1) | `1_800_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| MAX_SALE | $1,800,000 USDC (= 1,800,000 ARM at $1; equal to BASE_SALE, so no expansion) | `1_800_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| MIN_SALE (spec: MINIMUM_RAISE) | $250,000 USDC | `250_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| ELASTIC_TRIGGER (spec: EXPANSION_TRIGGER) | $1,800,000 USDC capped demand (equal to the sale size, so it has no effect) | `1_800_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| HOP2_RESERVE_USDC | $300,000 USDC first-priority capacity for hop-2 | `300_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| TEAM_PAYMENT_USDC | $250,000 USDC to `launchTeam` on a successful finalize (bounded by the distributable proceeds; must not exceed MIN_SALE) | `250_000_000_000` | USDC (6 dec) | Immutable (constant) | ☐ |
| ARM_PRICE | $1.00 per ARM | `1_000_000` (1e6 USDC per 1e18 ARM) | Ratio | Immutable (constant) | ☐ |
| TOTAL_SUPPLY | 12,000,000 ARM | `12_000_000_000_000_000_000_000_000` | ARM (18 dec) | — | Reference only (not in crowdfund contract) |

**Decimal conversion rules:**
- ARM amounts: multiply human-readable by `10^18`
- USDC amounts: multiply human-readable by `10^6`
- Price ratio: `1_000_000` USDC-units per `1_000_000_000_000_000_000` ARM-units

---

## 4. Hop Structure

| Parameter | Hop-0 | Hop-1 | Hop-2 | Mutability |
|---|---|---|---|---|
| Role | Known contributors | Team inviter wallet | Invited contributors | — |
| `HOPn_CAP_USDC` (per slot) | $100,000 (`100_000_000_000` USDC) | $0 (`0`) | $10,000 (`10_000_000_000` USDC) | Immutable (constant) |
| `hopConfigs[n].ceilingBps` | 0 (unused) | 0 (unused) | 0 (unused) | Set in constructor; kept for the getter's shape |
| Outgoing invite slots per slot (`HOPn_MAX_INVITES`) | 0 | 100 | 0 | Immutable (constant) |
| Incoming invite stacking cap (`HOPn_MAX_INVITES_RECEIVED`) | 1 | 1 | 20 | Immutable (constant) |
| Slot source | `SeedAdded` | `Invited` | `Invited` | — |

**Cap formula:** Per-address cap at hop = `participation_slots[(address, hop)] × HOP_CAP[hop]`

**Stacking cap semantics:** `maxInvitesReceived` bounds how many inbound invite edges a single (address, hop) node can accept. It is 1 at hop 0 and hop 1, so each of those nodes holds one cap and (at hop 1) one 100-slot invite budget. It is 20 at hop 2: each further invite to an existing hop-2 node adds a $10,000 slot (up to $200,000) without creating a new node. The cap is enforced inside `invite()`, `commitWithInvite()` and `launchTeamInvite()` — an invite beyond it reverts.

**Commitment floor (`MIN_COMMIT`):** `100 USDC` (`100_000_000` USDC, 6 decimals). Both `commit()` and `commitWithInvite()` revert with `amount < MIN_COMMIT`. Immutable (constant). Sized to keep dust commits out of the participant graph — every commit registers a `participantNode`, and the rounding buffer at finalization is bounded by `participantNodes.length`. Not enforced as a percentage of cap.

**Allocation amounts ($1.8M, the only sale size):** hop-2 reserved fill = min(hop-2 demand, $300k), served first; hop-0 = min(hop-0 demand, $1.8M less hop-2's reserved fill), so $1.5M plus any unused reserve; hop-1 = what remains (always $0 in practice); hop-2 extra = min(remaining hop-2 demand, what remains). Total allocation = min(capped demand, $1.8M); a hop is pro-rated only when total capped demand exceeds $1.8M. Each hop's final allocation is stored in `finalCeilings[h]` (CROWDFUND.md §Hop Structure).

---

## 5. Budgets

| Parameter | Value | Mutability | Verified | Notes |
|---|---|---|---|---|
| Hop-0 budget (`MAX_SEEDS`) | 500 (`uint16`) | Immutable (constant) | ☐ | Max `addSeed()` calls. A single `addSeeds` of 500 exceeds the per-tx gas cap; batch at most 180 (docs/safe-launch-batches.md) |
| Launch-team hop-1 budget (`LAUNCH_TEAM_HOP1_BUDGET`) | 1 (`uint8`) | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 0)` calls: the team inviter wallet |
| Launch-team hop-2 budget (`LAUNCH_TEAM_HOP2_BUDGET`) | 500 (`uint16`) | Immutable (constant) | ☐ | Max `launchTeamInvite(_, 1)` calls (repeat placements of one address stack hop-2 slots and each consume one unit) |
| `MAX_FINALIZE_NODES` | 1,800 | Immutable (constant) | ☐ | Hard cap on total `participantNodes`, enforced in `_initParticipant`. Keeps one-shot `finalize()` (~8,200 gas/node cold, ~15.2M at 1,800) under the **16,777,216 (2^24, EIP-7825) per-tx gas cap**. Node creation reverts `"node cap reached"` beyond it. Unreachable under the budgets below (a backstop). |
| Structural max network size | 1,101 nodes | Derived | — | 500 hop-0 + 1 team wallet + 100 team-wallet invites + 500 launch-team hop-2 (hop-2 stacking adds slots, not nodes). Below `MAX_FINALIZE_NODES`; one-shot cold `finalize()` at 1,101 measures ~9.41M gas on the success path |

---

## 6. EIP-712 Domain

| Field | Value | Mutability | Verified |
|---|---|---|---|
| `name` | `"ArmadaCrowdfund"` | Immutable (constant) | ☐ |
| `version` | `"1"` | Immutable (constant) | ☐ |
| `chainId` | `1` (Ethereum mainnet) | Derived: OpenZeppelin `EIP712` caches `block.chainid` at construction and rebuilds the separator if the chain id ever differs | ☐ |
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
| Quiet period | 10 days post-finalization | `ArmadaGovernor.QUIET_PERIOD_DURATION` | No proposals (including steward spends) until day 11. Constant. |
| Claim deadline | 3 years (94,608,000 seconds) | CROWDFUND.md §Finalization | Fixed term — but the crowdfund contract derives this from `finalizationTimestamp`, not a constructor arg |
| Proposal threshold | 5,000 ARM | GOVERNANCE.md | |
| Quorum | max(20% Standard / 30% Extended / 40% veto ratification × eligible supply, 100,000 ARM) | `ArmadaGovernor` | Eligible supply = total supply − treasury − quorum-excluded addresses (crowdfund, RevenueLock, reserve distributor), snapshotted at proposal creation. Quorum % is governance-settable within 5–50%; the 100,000 ARM floor (`QUORUM_FLOOR`) is a constant and applies to every vote type, including steward-spend defeat and veto ratification. |
| Standard proposal timing | 2-day voting delay, 7-day vote, 3-day execution delay | `ArmadaGovernor.initialize` | Initial values; governance-settable via `setProposalTypeParams` (Extended; delay 1–14d, vote 1–30d, execution 2–14d). Minimum lifecycle 12 days. |
| Veto ratification vote | 14 days, starts at the veto, 40% quorum | `ArmadaGovernor.initialize` | Fixed — excluded from `setProposalTypeParams`. Voting power is snapshotted at the block before the veto. Not created during the veto bootstrap (below). |
| Veto bootstrap | 70 days post-finalization (quiet period included); starts only at finalization | `ArmadaGovernor.VETO_BOOTSTRAP_DURATION` | A Security Council veto is final (no ratification vote, `ProposalVetoed` ratificationId 0). Before finalization, or with no crowdfund registered, vetoes create ratifications. Constant. |
| SC shield pause | Disabled (`MAX_PAUSE_DURATION` = 0) | `ShieldPauseController` | An SC pause expires in the block it is made; no post-wind-down emergency pause. Wind-down withdraw-only mode unaffected. Constant. |
| Redemption delay | 14 days after the wind-down trigger | `ArmadaRedemption.REDEMPTION_DELAY` | Sweep-coordination window before the first redemption; redemption is open indefinitely afterwards. Constant. |
| Reserve beneficiaries | Up to 75 grantees plus the allocator | `RevenueReserveDistributor.MAX_BENEFICIARIES` (76) | Worst-case `distribute()` ≈ 8.5M gas (51% of the 2^24 tx cap); `claimRange()` pages it. Constant. |
| Enabling ARM transfers (`setTransferable(true)`) | Extended proposal | `ArmadaGovernor.initialize` (`extendedSelectors`) | One-way. The wind-down contract calls the token directly and is unaffected. |
| `LIMIT_ACTIVATION_DELAY` | 24 days (2,073,600 seconds) | GOVERNANCE.md §Treasury Outflow Limits | Hardcoded constant in `ArmadaTreasuryGov`. Not governance-settable. `ArmadaGovernor.setProposalTypeParams` reverts if the Extended cycle (voting delay + voting period + execution delay) would reach its mirror constant `TREASURY_OUTFLOW_ACTIVATION_DELAY` (24 days). |

### 8.2 Deploy inputs — freeze before deploy

Unlike §8.1, these **are** deployment inputs for the governance / RevenueLock deploy (independent of the crowdfund constructor). They are immutable or protection-critical once set and must be finalized and two-person verified before deploy. Source of record: `config/networks.ts` (mainnet) → this sheet. This subsection is the single freeze location for these values — the tracking issues below should reference it rather than re-listing values.

| Parameter | Value | Mutability | Verified | Notes / tracking |
|---|---|---|---|---|
| RevenueLock beneficiary list | 107 direct entries totalling 1,997,050 ARM, from `config/revenue-lock-beneficiaries-mainnet.json` (gitignored; labels `beneficiary 001`–`107`); the reserve distributor is appended as entry 108 | Immutable (RevenueLock constructor) | ☐ | Direct entries plus the reserve cap must sum **exactly** to 2,400,000 × 10^18 ARM (`ARM_REVENUE_LOCK_ALLOCATION`); the deploy checks only this total, so the team / airdrop / reserve split must be reconciled against the approved cap table by hand. Loaded via `REVENUE_LOCK_BENEFICIARIES_FILE`, which lists the direct entries only: they plus the reserve cap make up the 2,400,000; deploy rejects Anvil placeholders on non-local. Tracking: #144. The schedule must identify the reserve distributor and separately reviewed airdrop distributor, reconcile categories with the approved cap table, and persist original constructor ordering; individual airdrop recipients are not assumed to be direct entries. The file's labels must be neutral (`beneficiary NNN`, in list order) because the deploy prints them; the list mapping those numbers to names is kept outside the repo, and the pre-commit hook refuses any other label. |
| Reserve cap | 402,950 ARM = 402,950 × 10^18 (`402950000000000000000000`; set in whole ARM as `REVENUE_RESERVE_AMOUNT=402950`) | Immutable (distributor constructor) | ☐ | Within the 2,400,000 ARM lock budget; 360,000 ARM / 3% is a worked example only. Reconcile the reported 120,000 ARM / 1% cap-table reserve before launch; this PR does not change category ownership. `REVENUE_RESERVE_AMOUNT` (whole ARM) in `config/mainnet.env` — **required** on mainnet (no default). Tracking: #582. |
| Reserve allocator | `0x4932ad7d2317f450eE4Cc479456Fd64963b516C6` (`REVENUE_RESERVE_ALLOCATOR`) | Immutable (distributor constructor) | ☐ | Exactly three identified owners, threshold two; confirm chain/address, implementation, modules, guard, fallback handler, quorum eligibility and absence from `noDelegation`. `REVENUE_RESERVE_ALLOCATOR` in `config/mainnet.env` — **required** on mainnet (no default). Must differ from the deployer, Security Council and launch team (checked before the first transaction). Tracking: #582. |
| Treasury outflow limit — USDC | 30-day window; max($100,000, 10% of treasury USDC); no floor (`2592000`, `1000` bps, `100000000000`, `0`) | Set at deploy (timelock `initOutflowConfig`); window/bps/absolute governance-adjustable after; the floor is fixed at deploy (no setter) | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_USDC_*` in `config/mainnet.env`. Tracking: #348. |
| Treasury outflow limit — ARM | 30-day window; max(25,000 ARM, 0.02% of treasury ARM); no floor (`2592000`, `2` bps, `25000e18`, `0`) — the absolute amount binds (≈ 25,000 ARM per 30 days initially) | Set at deploy (timelock `initOutflowConfig`); window/bps/absolute governance-adjustable after; the floor is fixed at deploy (no setter) | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_ARM_*` in `config/mainnet.env`. Tracking: #348. |
| Treasury outflow limit — ETH (`address(0)`) | 30-day window; max(25 ETH, 10% of treasury ETH); no floor (`2592000`, `1000` bps, `25e18`, `0`) | Set at deploy (timelock `initOutflowConfig`); window/bps/absolute governance-adjustable after; the floor is fixed at deploy (no setter) | ☐ | From GOVERNANCE.md §Treasury Outflow Limits. `OUTFLOW_ETH_*` in `config/mainnet.env`. Tracking: #348. |
| RevenueLock `MAX_REVENUE_INCREASE_PER_DAY` | $10,000/day = 10,000 × 10^18 (`10000000000000000000000`, 18-decimal USD) | Immutable (RevenueLock constructor); not governance-settable | ☐ | 18-decimal USD to match `RevenueCounter.recognizedRevenueUsd` — **not** 6-decimal USDC; a 10^6 value would cap the ratchet at $0.00000001/day and lock beneficiaries out permanently. Calibrated (issue #225) to require minimum 100 days for malicious $0 → $1M full-unlock acceleration under captured governance, assuming `syncObservedRevenue()` is called at least daily. Defensive security calibration, not steady-state economic parameter. Effective rate cap depends on regular sync calls; without regular syncs, the cap accumulates over idle periods (start the daily sync on deploy day). `REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD` (whole USD) in `config/mainnet.env`; config rejects non-integers and values above $1,000,000. Also applies to later cohorts (`deploy_revenue_lock_cohort.ts`). Source: REVENUE_LOCK.md §6, ARM_TOKEN.md §5.1. Tracking: #530. |
| Wind-down revenue threshold | $10,000 cumulative = 10,000 × 10^18 (`10000000000000000000000`, 18-decimal USD; set in whole USD as `WINDDOWN_REVENUE_THRESHOLD=10000`) | Set at deploy (ArmadaWindDown constructor); governance-adjustable pre-trigger (`setRevenueThreshold`) | ☐ | Below-threshold recognized revenue at the deadline makes wind-down **permissionlessly triggerable**. Recognized revenue only advances via the Launch 2 fee module — set with a Launch 2 schedule buffer so the pool has time to ship. Value per GOVERNANCE.md / CROWDFUND.md §Wind-Down. `WINDDOWN_REVENUE_THRESHOLD` is **required** on mainnet (no default in `config/networks.ts`). Tracking: #381 (feasibility C2). |
| Wind-down deadline | `2027-12-31T00:00:00Z` (unix `1830211200`) | Set at deploy (ArmadaWindDown constructor); governance-adjustable pre-trigger (`setWindDownDeadline`) | ☐ | The date the permissionless trigger arms if revenue is under threshold. Must leave headroom for the Launch 2 (shielded pool) deploy + fee revenue ramp; governance is expected to retarget it to ~6 months after Launch 2 once that date is known (CROWDFUND.md §Wind-Down). `WINDDOWN_DEADLINE` is **required** on mainnet (no default in `config/networks.ts`). Tracking: #381 (feasibility C2). |
| Wind-down guardian | The launch-team Safe (`LAUNCH_TEAM_ADDRESS`) | Set at deploy (ArmadaWindDown constructor); only the guardian can change it, and only to `address(0)` (`renounceGuardian()`, irreversible) | ☐ | `guardianTriggerWindDown()` at any time, outside governance and the veto; last-resort mandate in GOVERNANCE.md §Wind-Down. Raise the Safe to 2-of-3 before finalization |
| Initial Treasury Steward | `0x966352D336FDf5De28D06D5fCbda41C2Be30f781` (`INITIAL_STEWARD_ADDRESS`) | Set at deploy (timelock `electSteward`); 180-day term from the deploy block; re-election Extended, removal Standard | ☐ | `INITIAL_STEWARD_ADDRESS` in `config/mainnet.env` — **required** on mainnet (no default). Exactly three identified owners, threshold two (checked on-chain before the first transaction, as for the reserve allocator); must differ from the deployer, Security Council, launch team, reserve allocator, treasury, timelock and governor. Confirm chain/address, implementation, modules, guard and fallback handler. Tracking: #221. |
| USDC steward budget | $60,000 per rolling 30 days (`60000` whole USD → `60000000000` at 6dp, `2592000`) | Set at deploy (timelock `addStewardBudgetToken`); increase / extend Extended; decrease also Extended at launch (`updateStewardBudgetToken` is classified Extended in both directions); remove Standard | ☐ | From GOVERNANCE.md §Treasury Steward. `STEWARD_BUDGET_USDC` (whole USD; config rejects values above the USDC outflow absolute limit) and `STEWARD_BUDGET_WINDOW` in `config/mainnet.env`; the deploy refuses a hub USDC that does not report 6 decimals. Accepted launch-window exposure: GOVERNANCE.md §Election. Tracking: #222. |
| ARM distribution | Treasury 7,800,000 / Crowdfund 1,800,000 / RevenueLock 2,400,000 ARM (sums to the 12,000,000 supply; deployer keeps 0) | One-time transfers at deploy | ☐ | `ARM_TREASURY_ALLOCATION` / `ARM_CROWDFUND_ALLOCATION` / `ARM_REVENUE_LOCK_ALLOCATION` (whole ARM) in `config/mainnet.env`. The deploy halts unless the three balances match exactly, total supply is 12,000,000 and the deployer holds 0 ARM afterwards. |
| Timelock delay | 2 days (`172800`) | Timelock `minDelay`; governance can change it, but the governor rejects any `updateDelay` above 2 days | ☐ | `TIMELOCK_DELAY` in `config/mainnet.env`. With `HARDEN_TIMELOCK=true` (forced on mainnet) the timelock is deployed at delay 0, the deployer runs the timelock-only setup, then the delay is raised to this value and every deployer timelock role is renounced (#347). |

---

## 9. Settlement Mode

| Parameter | Value | Verified | Notes |
|---|---|---|---|
| Settlement mode | Lazy settlement | ✓ | `finalize()` writes aggregate state only; `Allocated` + `AllocatedHop` emitted at individual `claim()` time. No `emitSettlement()`, no `SettlementComplete`. |
| Gas estimate at max network | `[TBD]` gas | ☐ | From `scripts/crowdfund_gas_dryrun.ts` (fills to `MAX_FINALIZE_NODES`, finalizes, asserts gasUsed < 2^24) |
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
| ARM balance verified (≥ 1,800,000e18, MAX_SALE) | ☐ |
| Observer confirmed operational | ☐ |
| Committer confirmed operational | ☐ |
| Settlement mode confirmed | Lazy settlement |

---

## 12. Mutability Summary

Every parameter in this contract falls into one of three categories:

| Category | Meaning | Examples |
|---|---|---|
| **Immutable (constant)** | Hardcoded in contract bytecode. Cannot change after compilation. | BASE_SALE, MAX_SALE, HOP_CAP, HOP2_RESERVE_USDC, TEAM_PAYMENT_USDC, hop-0 budget, invite limits |
| **Immutable (constructor)** | Set once at deployment via constructor args. Cannot change after deployment. | Treasury address, ROOT address, Security Council address, timestamps, chainId |
| **Immutable (derived)** | Computed at deployment or finalization from other immutables. Cannot change. | DOMAIN_SEPARATOR, claim deadline (finalizationTimestamp + 3 years) |

**The only admin-mutable parameter in the crowdfund contract is the commitment deadline.** The launch team can extend it (together with the launch-team deadline) via `extendWindow()`, only while the window is open, only later, and never beyond the predeclared maximum window. No other parameter can change after deployment.

The only role-gated *actions* are:
- ROOT: `addSeed()`, `launchTeamInvite()` — during the commitment window only (days 1-5, plus any extension)
- ROOT: `extendWindow()` — while the window is open, up to the maximum window
- Security Council: `cancel()` — pre-finalization only

Apart from `extendWindow()`, none of these changes a parameter. They execute predeclared actions within predeclared budgets.

---

## 13. Cross-Document Reference

This manifest is referenced by:

| Document | What it uses from here |
|---|---|
| CROWDFUND.md | All economic constants; hop structure; timing |
| OPERATIONS.md | Constructor params checklist (§2); deployment record |
| MONITORING.md | Alert thresholds; timestamp boundaries; budget caps |
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
| Reserve allocator Safe + reserve cap finalized (§8.2, #582) | ☐ | |
| Initial steward Safe + USDC steward budget finalized (§8.2, #221, #222) | ☐ | |
| All timestamps independently converted and verified | ☐ | |
| All decimal-encoded values independently computed and verified | ☐ | |
| EIP-712 domain fields confirmed | ☐ | |
| Token decimals verified on-chain | ☐ | |
| Settlement mode confirmed from gas testing | ☐ | |
| OPERATIONS.md §2 checklist matches this manifest exactly | ☐ | |
| MONITORING.md alert thresholds reference these values | ☐ | |
| Two independent reviewers have signed off on all values | ☐ | |

**Once all items are checked, this document is frozen. No changes without re-running the full checklist.**
