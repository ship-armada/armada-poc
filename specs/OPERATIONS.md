# Armada Crowdfund — Deployment, Operations, and Failure Runbook

This document covers every operational step from pre-deployment through post-finalization, including failure scenarios. It is written for the person executing each action, not for a general audience.

**Format for every action:**
- **Actor** — who performs this
- **Action** — what they do
- **Preconditions** — what must be true before starting
- **On-chain confirmation** — how to verify it worked
- **Fallback** — what to do if it fails

---

## 1. Roles and Wallet Inventory

Complete this table before deployment. Every address must be confirmed before any on-chain action.

| Role | Description | Address | Wallet type | Quorum |
|---|---|---|---|---|
| Deployer | Deploys the contract | `[TBD]` | Multisig required (not EOA) | — |
| Treasury | Receives net USDC proceeds + unsold/unclaimed ARM | `[TBD]` | Multisig | `[TBD]` |
| ROOT / Launch team | `addSeed()`, `launchTeamInvite()` | `[TBD]` | Multisig | `[TBD]` |
| Security Council | `cancel()` authority | `[TBD]` | 3-of-5 multisig | 3-of-5 |
| ARM token contract | Source of preloaded ARM | `[TBD]` | — | — |
| USDC token contract | Committed currency | Circle mainnet USDC | — | — |

**Key access rules (from CROWDFUND.md):**
- `addSeed()` and `launchTeamInvite()`: ROOT only, week 1 only
- `cancel()`: Security Council only, pre-finalization only
- `finalize()`, `withdrawUnallocatedArm()`: permissionless (anyone)
- `claim(delegate)`, `claimRefund()`: permissionless (participant-initiated)
- `computeAllocation(address)`: public view function (anyone)
- `loadArm()`: permissionless (anyone), callable once

**Before deployment:** confirm all signers for each multisig are reachable and have tested signing. Security Council quorum must be reachable within 1 hour during the commitment window.

---

## 2. Pre-Launch Checklist

Complete every item before calling the deploy script. Sign off with initials and timestamp.

### Constructor parameters

| Parameter | Expected value | Verified | Notes |
|---|---|---|---|
| Treasury address | `[address]` | ☐ | Immutable post-deploy |
| ARM token address | `[address]` | ☐ | Verify against official ARM deployment |
| USDC token address | Circle mainnet USDC | ☐ | 6 decimals |
| ROOT / launch team address | `[address]` | ☐ | Must match multisig above |
| Security Council address | `[address]` | ☐ | Must match 3-of-5 multisig above |
| Commitment window open timestamp | `[unix timestamp]` | ☐ | Verify against intended date/time + timezone |
| Commitment deadline timestamp | `[unix timestamp]` | ☐ | Open + 21 days |
| Launch team invite deadline | `[unix timestamp]` | ☐ | Open + 7 days |
| MAX_SALE | 1,800,000 × 10^18 | ☐ | ARM units (18 decimals) |
| BASE_SALE | 1,200,000 × 10^18 | ☐ | ARM units |
| MINIMUM_RAISE | 1,000,000 × 10^6 | ☐ | USDC units (6 decimals) |
| EXPANSION_TRIGGER | 1,500,000 × 10^6 | ☐ | USDC units |
| Hop-0 budget | 160 | ☐ | Max hop-0 participants |
| Launch team hop-1 budget | 60 | ☐ | |
| Launch team hop-2 budget | 60 | ☐ | |

### EIP-712 domain

| Field | Expected value | Verified |
|---|---|---|
| `name` | "ArmadaCrowdfund" | ☐ |
| `version` | "1" | ☐ |
| `chainId` | `[chain ID]` | ☐ |
| `verifyingContract` | Set at deployment (contract address) | ☐ — verify post-deploy |

### Token verification

| Check | Result | Verified |
|---|---|---|
| ARM token decimals | 18 | ☐ |
| USDC token decimals | 6 | ☐ |
| ARM token address matches CREATE2 precomputed address | `[address]` | ☐ |

### Infrastructure

| Check | Verified |
|---|---|
| Observer URL is live and loading events | ☐ |
| Committer URL is live and wallet connection works | ☐ |
| RPC fallback providers configured and tested | ☐ |
| Monitoring alerts configured (see §8) | ☐ |
| Security Council members confirmed reachable | ☐ |

---

## 3. Deployment Sequence

Execute in exact order. Do not proceed to the next step until the previous step's on-chain confirmation is verified.

### Step 1: Deploy contract

| | |
|---|---|
| **Actor** | Deployer |
| **Action** | Run deploy script with verified constructor params |
| **Preconditions** | All pre-launch checklist items signed off |
| **On-chain confirmation** | Contract address returned; verify on block explorer: correct bytecode, correct constructor args |
| **Fallback** | If deploy fails: debug constructor params; do not redeploy without re-running full checklist |

Record: `contract_address = [address]`, `deploy_tx = [hash]`, `block = [number]`

### Step 2: Verify contract source

| | |
|---|---|
| **Actor** | Deployer |
| **Action** | Submit source to block explorer verification (Etherscan/Basescan) |
| **Preconditions** | Step 1 complete |
| **On-chain confirmation** | Explorer shows verified ✓ with correct source and ABI |
| **Fallback** | If verification fails: debug compilation settings; the contract is deployed and functional regardless — verification is a transparency step, not a gating condition |

### Step 3: Verify EIP-712 domain separator

| | |
|---|---|
| **Actor** | Deployer |
| **Action** | Call `DOMAIN_SEPARATOR()` view function; verify it matches expected value computed from domain fields |
| **Preconditions** | Step 2 complete |
| **On-chain confirmation** | Returned value matches locally computed `keccak256(encode(domainFields))` |
| **Fallback** | If mismatch: do NOT proceed. Contract has wrong domain separator — redeploy. |

### Step 4: Verify ARM balance

| | |
|---|---|
| **Actor** | Deployer |
| **Action** | Verify `ARM.balanceOf(crowdfundContract)` = 1,800,000e18. The ARM token constructor mints directly to the crowdfund contract — no manual transfer needed. |
| **Preconditions** | Step 3 complete; ARM token deployed (constructor minted 1.8M directly to crowdfund contract) |
| **On-chain confirmation** | `ARM.balanceOf(crowdfundContract)` = 1,800,000e18 |
| **Fallback** | If balance is wrong: ARM token was deployed with incorrect constructor params. Redeploy ARM token. |

### Step 5: Load ARM

| | |
|---|---|
| **Actor** | Anyone (typically deployer) |
| **Action** | Call `loadArm()` — verifies the ARM balance and sets the flag that arms the sale. The commitment window opens at the configured open timestamp, not at the moment `loadArm()` is called. If `loadArm()` is called before the open timestamp, the contract is armed but commitments will revert until the window opens. |
| **Preconditions** | `ARM.balanceOf(crowdfundContract)` = 1,800,000e18 (Step 4 verified) |
| **On-chain confirmation** | `ArmLoaded` event emitted |
| **Fallback** | If `loadArm()` reverts: check contract ARM balance equals MAX_SALE exactly; check `loadArm()` has not already been called |

Record: `loadArm_tx = [hash]`

> **If `loadArm()` was called before `openTimestamp`:** Stop here. Verify observer shows ARMED / PRE-OPEN. Do not proceed to Steps 6, 7, or 9 until `block.timestamp ≥ openTimestamp`. The contract is armed but commitments will revert and `addSeed()` / `launchTeamInvite()` may also revert until the week-1 window is active.

> **At or after `openTimestamp`:** Continue to Steps 6, 7, 8, and 9 in order.

### Step 6: Add initial seeds

**Execute only once `block.timestamp ≥ openTimestamp` and the week-1 window is active.**

See §4 (Week-1 operating cadence) for the full seed addition procedure. The first batch of seeds should be added immediately once the week-1 window is active (`block.timestamp ≥ openTimestamp`), before announcing the sale.

### Step 7: Issue launch-team placements (if any are pre-planned)

**Execute only once `block.timestamp ≥ openTimestamp` and before `launchTeamInviteDeadline`.**

See §4 for the launch-team invite procedure.

### Step 8: Verify observer and committer

| | |
|---|---|
| **Actor** | Deployer or ops |
| **Action** | Load observer; confirm `ArmLoaded` and any `SeedAdded` events appear; confirm stats banner shows correct state. If `block.timestamp < openTimestamp`: observer should show "ARMED / PRE-OPEN" (or equivalent) — not "OPEN". Commitments will start working once the open timestamp is reached. If `block.timestamp ≥ openTimestamp`: observer should show "OPEN" with correct countdown. Test wallet connection on committer. |
| **Preconditions** | Pre-open path: Step 5 complete. Open path: Steps 5–7 complete. |
| **On-chain confirmation** | Observer reflects correct state (pre-open or open) and correct hop-0 count |
| **Fallback** | If observer not loading: check RPC provider; check contract address in observer config |

### Step 9: Announce sale open

**Do not announce until Step 8 confirms observer shows OPEN (not merely ARMED / PRE-OPEN).** Publish observer and committer URLs. Send participant communications.

---

## 4. Week-1 Operating Cadence

Week 1 is the highest-risk operational phase. Hop-0 participants are added, launch-team budgets are spent, and these actions are either irreversible (`invite()` path) or immediately visible on-chain. Execute with care.

### Adding a hop-0 participant

| | |
|---|---|
| **Actor** | ROOT (launch team multisig) |
| **Action** | Call `addSeed(address)` |
| **Preconditions** | Within week-1 window; hop-0 count < 160; address not already a seed (duplicate `addSeed()` for the same address is invalid); address confirmed with seed (they know what they're signing up for); entry recorded in decision log (§10) |
| **On-chain confirmation** | `SeedAdded(address)` event emitted; observer shows new hop-0 node with edge from ROOT |
| **Fallback** | If `addSeed()` reverts: check week-1 deadline; check hop-0 count; see failure scenario §9.1 (wrong seed added) |

### Issuing a launch-team hop-1 or hop-2 placement

| | |
|---|---|
| **Actor** | ROOT (launch team multisig) |
| **Action** | Call `launchTeamInvite(invitee, fromHop)` where `fromHop` is 0 (for hop-1 placement) or 1 (for hop-2 placement) |
| **Preconditions** | Within week-1 window; budget remaining for target hop; invitee address confirmed; entry recorded in decision log (§10) |
| **On-chain confirmation** | `Invited(ROOT, invitee, fromHop+1, 0)` emitted; observer shows new node with dashed edge from ROOT |
| **Fallback** | If placement was wrong: see failure scenario §9.2 (bad launch-team invite) |

### Daily checks (days 1–7)

Each day during week 1, the operator should verify:

- [ ] Current hop-0 count (observer or `seedCount()` view)
- [ ] Remaining hop-0 budget: 160 − current count
- [ ] Remaining launch-team hop-1 budget: 60 − issued count
- [ ] Remaining launch-team hop-2 budget: 60 − issued count
- [ ] Any unexpected addresses in the graph (check for anomalies)
- [ ] Total `capped_demand` trend (is it on track for minimum raise?)
- [ ] Observer and committer responding normally
- [ ] No anomalous contract calls (check events for unexpected interactions)

### End-of-week-1 go/no-go checkpoint

Before the launch-team invite window closes (end of day 7), verify:

| Condition | Status | Owner |
|---|---|---|
| All planned hop-0 participants added or explicitly deferred | ☐ | ROOT |
| All planned launch-team hop-1 placements issued or budget explicitly reserved | ☐ | ROOT |
| All planned launch-team hop-2 placements issued or budget explicitly reserved | ☐ | ROOT |
| Remaining budgets documented (no phantom unspent slots) | ☐ | ROOT |
| `capped_demand` trend reviewed; minimum raise reachable | ☐ | Ops |
| Security Council confirmed reachable for remainder of window | ☐ | Ops |

**If minimum raise looks unreachable:** Do not cancel yet. Week-1 demand is rarely representative of final demand. Monitor through week 2 before any decision. Cancel is only appropriate for catastrophic events (exploit, legal injunction), not low demand.

---

## 5. Weeks 2–3 Operating Cadence

After the launch-team invite window closes, the operator's role is monitoring, not action.

### Daily checks (days 8–21)

- [ ] `capped_demand` vs MINIMUM_RAISE ($1M) and EXPANSION_TRIGGER ($1.5M)
- [ ] Per-hop demand vs ceilings (observer stats banner)
- [ ] Commitment count and graph growth
- [ ] Observer and committer responding normally
- [ ] No anomalous contract calls

### Pre-finalization go/no-go checkpoint

After commitment deadline passes (day 21+), before calling `finalize()`:

| Condition | Check | Owner |
|---|---|---|
| `block.timestamp > commitmentDeadline` | Confirmed | Ops |
| `capped_demand ≥ MINIMUM_RAISE ($1M)` | Read from contract state, or derive from events using slot-capped logic: for each `(address, hop)`, cap = `participation_slots[(address, hop)] × HOP_CAP[hop]`; sum across all pairs. Do **not** sum raw `Committed` amounts — that overstates demand and may give a false go signal. | Ops |
| `cancelled == false` | Read from contract state | Ops |
| `finalized == false` | Read from contract state | Ops |
| Gas estimation for `finalize()` | Run `eth_estimateGas`; compare to block gas limit (should be 3-5M under lazy settlement) | Ops |

**If `capped_demand < MINIMUM_RAISE`:** Call `finalize()` anyway — it is permissionless and will set `refundMode = true`, enabling refunds via `claimRefund()` and ARM recovery via `withdrawUnallocatedArm()`. Announce to participants immediately.

---

## 6. Finalization Procedure

### Lazy settlement architecture

Under lazy settlement, `finalize()` writes only aggregate state — zero per-participant storage writes. Individual allocations are computed on-the-fly by `computeAllocation(address)` and executed when each participant calls `claim(delegate)`. There is no settlement mode selection, no `emitSettlement()`, and no batched event emission. See `CROWDFUND.md` §Finalization and §Gas Considerations.

**Gas estimation:** `finalize()` iterates all participants once to compute `hopDemand[]` — estimated 3-5M gas at ~800 participants. Run `eth_estimateGas` before calling to confirm. If it exceeds 25M, investigate the participant count and storage layout before proceeding.

---

### Step 1: Call `finalize()`

| | |
|---|---|
| **Actor** | Anyone (typically ops) |
| **Action** | Call `finalize()` |
| **Preconditions** | Pre-finalization go/no-go checkpoint passed |
| **On-chain confirmation** | `Finalized(saleSize, totalAllocatedArm, netProceeds, refundMode)` emitted; aggregate state written; USDC transferred to treasury (success path) |
| **Fallback** | If tx reverts: check preconditions; check gas limit; see §9.6 |

Record: `finalize_tx = [hash]`, `block = [number]`, `refundMode = [true/false]`, `netProceeds = [amount]`

### Step 2: Verify outcome

- Read `Finalized` event: `refundMode` field
- If `refundMode == false`: success path — proceed to Step 3
- If `refundMode == true`: refundMode path — proceed to §6 Path C

### Step 3: Post-finalization verification (success path)

- [ ] Treasury received proceeds: verify `USDC.balanceOf(treasury)` increased by approximately `netProceeds` from the `Finalized` event, minus the rounding buffer (`participantNodes.length × NUM_HOPS` USDC units). The event's `netProceeds` is the theoretical allocated USDC; the actual transfer is reduced by the buffer. A difference within the buffer is expected; a difference exceeding it indicates a real mismatch.
- [ ] Aggregate state is correctly written: read `saleSize`, `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`, `totalArmTransferred == 0` from contract
- [ ] Verify `computeAllocation(address)` returns correct values for a sample of known participants (spot-check against manual calculation)
- [ ] Unsold ARM: `ARM.balanceOf(crowdfundContract)` > `totalAllocatedArm` (unsold portion is sweepable)
- [ ] No `Allocated` or `AllocatedHop` events yet — those are emitted at `claim()` time, not at finalization
- [ ] Update observer/committer to "FINALIZED" state (should happen automatically from `Finalized` event)
- [ ] Announce to participants: "Crowdfund finalized — ARM claims and refunds now available via `claim(delegate)`"

---

### Path C: RefundMode outcome

This occurs when `finalize()` succeeds (capped_demand ≥ MINIMUM_RAISE) but `net_proceeds < MINIMUM_RAISE` after allocation — typically when hop-0 is oversubscribed at base size and later hops don't close the gap.

| | |
|---|---|
| **On-chain state** | `finalized == true`, `refundMode == true`; no ARM allocated; no treasury transfer; no `Allocated` events |
| **Participant action** | Call `claimRefund()` to recover full deposited USDC |
| **Operator action** | Announce immediately: "Crowdfund entered refund mode — full refunds available"; update UI messaging |
| **ARM** | All 1,800,000 ARM sweepable via `withdrawUnallocatedArm()` — call and verify transfer to treasury |

Verify: `ARM.balanceOf(crowdfundContract)` drops to 0 after `withdrawUnallocatedArm()`.

---

## 7. Cancel Procedure

Cancel is only for catastrophic events: active exploit, regulatory injunction, or another event that makes proceeding harmful to participants. It is not for low demand or launch delays.

### Decision checklist before calling `cancel()`

- [ ] Nature of the emergency: `[describe]`
- [ ] Is this reversible by any other means? If yes: use that means instead.
- [ ] Security Council quorum (3-of-5) confirmed and reachable
- [ ] Decision recorded in decision log with rationale
- [ ] Participant announcement drafted and ready to publish simultaneously

### Calling `cancel()`

| | |
|---|---|
| **Actor** | Security Council (3-of-5 multisig) |
| **Action** | Propose and execute `cancel()` |
| **Preconditions** | `finalized == false`; 3-of-5 quorum; emergency decision recorded |
| **On-chain confirmation** | `Cancelled` event emitted; `cancelled == true`; `finalize()` now reverts; `commit()` now reverts |
| **Fallback** | If multisig execution fails: check quorum; check nonce; do not retry until root cause understood |

Record: `cancel_tx = [hash]`, `block = [number]`, `rationale = [description]`

### Immediately after `cancel()`

- [ ] Publish participant announcement: crowdfund cancelled, full refunds available via `claimRefund()`
- [ ] Update observer/committer to "CANCELLED" state (automatic from `Cancelled` event)
- [ ] Call `withdrawUnallocatedArm()` to sweep all 1,800,000 ARM to treasury
- [ ] Verify `ARM.balanceOf(crowdfundContract)` = 0

---

## 8. Post-Finalization Operations

### Proceeds verification

| | |
|---|---|
| **Actor** | Treasury |
| **Action** | Record `USDC.balanceOf(treasury)` **before** calling `finalize()`. After finalization, verify the balance increased by approximately `netProceeds` from the `Finalized` event, minus the rounding buffer (`participantNodes.length × NUM_HOPS` USDC units). The event's `netProceeds` is the theoretical allocated USDC; the actual transfer is reduced by the buffer to ensure the contract never runs short on refund payouts. A difference within the buffer is expected; a difference exceeding it requires investigation. Do not compare against the absolute post-finalization balance — the treasury may hold USDC from other sources. |
| **Preconditions** | Successful finalization (not refundMode) |
| **Fallback** | If proceeds delta mismatch: investigate immediately; do not transfer or use until reconciled |

### Unsold ARM sweep

| | |
|---|---|
| **Actor** | Anyone (typically ops) |
| **Action** | Call `withdrawUnallocatedArm()` |
| **Preconditions** | `finalized == true`; within 3-year deadline; unsold ARM > 0 |
| **On-chain confirmation** | `ARM.balanceOf(treasury)` increases by `1,800,000 - totalAllocatedArm` |
| **Fallback** | If nothing to sweep (fully allocated): no action needed |

### Claims monitoring

Monitor `Allocated` and `RefundClaimed` events. No operator action required — these are participant-initiated. `Allocated` events are emitted at `claim()` time and include `armTransferred` (actual ARM sent — 0 if claimed after 3-year expiry), `refundUsdc` (USDC refund paid), and `delegate` (delegation target). Track participation rate to identify participants who may need reminders.

The `computeAllocation(address)` view function can be used to check any participant's theoretical entitlement at any time after finalization — useful for support inquiries.

Suggested monitoring thresholds (first 30 days post-finalization):
- Alert if < 50% of participants have claimed via `claim()` after 14 days
- Alert if total `armTransferred` (from `Allocated` events) < 50% of `totalAllocatedArm` after 14 days

### 3-year deadline sweep

Record the claim deadline: `finalization_block_timestamp + (3 * 365 * 24 * 3600)` seconds. Set a calendar reminder well in advance.

When `block.timestamp > finalization_timestamp + (3 * 365 * 24 * 3600)`:

| | |
|---|---|
| **Actor** | Anyone (typically treasury ops) |
| **Action** | Call `withdrawUnallocatedArm()` — sweeps `1,800,000 - totalArmTransferred` (all remaining ARM: unsold + allocated-but-unclaimed + forfeited by post-expiry claimants) |
| **Preconditions** | `block.timestamp > finalization_timestamp + (3 × 365 × 24 × 3600)` — strict post-deadline. Claims are available *through* the deadline; the expanded sweep formula (using `totalArmTransferred` instead of `totalAllocatedArm`) is only eligible *after* the deadline passes. |
| **On-chain confirmation** | `ARM.balanceOf(crowdfundContract)` = 0; treasury ARM balance increases by the swept amount |
| **Fallback** | If contract ARM balance already 0: nothing to sweep; verify no ARM was accidentally sent to the contract address |

---

## 9. Failure Scenarios

### 9.1 Wrong hop-0 participant added

**Detection:** Operator or community notices incorrect `SeedAdded` event.

**Impact:** `addSeed()` is irrevocable — the address has a permanent hop-0 position. They will appear in the graph and can commit and invite others.

**Options:**
- If discovered during week 1: cannot be undone. Assess whether the address poses a genuine governance risk. If severe (compromised key, adversarial actor): escalate to Security Council for cancel decision.
- If discovered post-week-1: no action available; monitor the address's behavior in the graph.
- In all cases: record in decision log with rationale for how it happened and what was decided.

**Prevention:** Confirm every seed address directly with the intended recipient before calling `addSeed()`. Use a pre-signed message or voice confirmation.

---

### 9.2 Bad launch-team invite issued

**Detection:** Operator notices incorrect `Invited` event from ROOT.

**Impact:** Same as wrong seed — irrevocable. The invitee has a permanent position at their hop level.

**Options:** Same as §9.1. The hop-1/hop-2 position has lower governance weight than hop-0, so the risk is lower. Document and monitor.

---

### 9.3 Signer unavailable (multisig)

**Detection:** Cannot reach enough multisig signers for a required action (ROOT invite, Security Council cancel).

**Severity by action:**
- ROOT invite during week 1: non-critical; delay the invite until quorum is reachable.
- Security Council cancel during active exploit: critical — activate backup signer protocol immediately.

**Mitigation:**
- Maintain a documented backup contact list for all multisig signers.
- Test multisig signing 48 hours before the commitment window opens.
- Security Council: 3-of-5 means 2 signers can be unavailable. Know who the 5 are at all times.

---

### 9.4 Observer or committer outage

**Detection:** Observer/committer URLs return errors or show stale data.

**Impact:** Participants cannot see the graph or commit. This does not affect the contract — commitments can still be submitted directly if participants have the ABI.

**Immediate actions:**
- Check RPC provider status (primary and fallback)
- If RPC issue: switch to fallback provider in app config; redeploy if needed
- If app issue: revert to last known-good deployment
- If extended outage: communicate clearly to participants; state what actions are still available (direct contract interaction)
- The commitment deadline does not pause for UI outages — participants who miss the window because of UI outage have no remedy

---

### 9.5 RPC/indexing issues

**Detection:** Observer shows stale event data; incorrect stats.

**Immediate actions:**
- Verify primary RPC is synced and responding
- Switch observer to fallback RPC
- Confirm contract state directly via block explorer as source of truth
- Do not make any operational decisions based on observer data if RPC is suspected unreliable

---

### 9.6 Gas too high for finalization

**Detection:** `eth_estimateGas` for `finalize()` exceeds expected range (3-5M), or `finalize()` tx reverts with out-of-gas.

Under lazy settlement, `finalize()` writes only aggregate state — it should be well within block gas limits at ~800 participants. If gas is unexpectedly high, investigate:

- **Participant count higher than expected?** More participants = more SLOADs during `hopDemand` iteration. Check actual participant count against the ~800 estimate.
- **Storage layout issue?** Cold reads (2,100 gas) vs warm reads (100 gas) depend on storage packing. If participant data is spread across many storage slots, cold read costs accumulate.
- **Contract bug?** `finalize()` should not be writing per-participant state. If it is, the lazy settlement architecture is not correctly implemented.

**If `finalize()` reverts:** The transaction reverted atomically — no state was written. Verify `finalized == false` on-chain. Investigate root cause before retrying. Gas estimation should have caught this in pre-finalization checkpoint.

**Prevention:** Gas benchmarking during development with realistic participant and slot distributions (see IMPLEMENTATION_TEST.md S16).

---

### 9.7 RefundMode surprise

**Detection:** `Finalized` event has `refundMode == true` despite `capped_demand ≥ MINIMUM_RAISE`.

**What happened:** `capped_demand` met the threshold but `net_proceeds < MINIMUM_RAISE` after allocation — this occurs at base size when hop-0 is oversubscribed and combined later-hop allocation doesn't reach $1M. It cannot occur after expansion (expanded hop-0 ceiling > $1M).

**Immediate actions:**
- Announce immediately: "Crowdfund entered refund mode — full refunds available"
- All participants can call `claimRefund()` for their full deposited USDC
- Call `withdrawUnallocatedArm()` to sweep all 1,800,000 ARM to treasury
- Update observer/committer to show "REFUND MODE"
- No ARM is allocated; no treasury USDC transfer occurred

This is not an exploit. The mechanism operated correctly. The announcement should explain why it happened in plain terms.

---

### 9.8 Cancel trigger

For the full cancel procedure see §7. This failure scenario covers the decision process.

**Valid reasons to cancel:**
- Active contract exploit
- Regulatory injunction requiring immediate halt
- Critical security disclosure that makes proceeding harmful

**Not valid reasons:**
- Low demand: call `finalize()` — sets `refundMode = true`, enabling refunds and ARM recovery
- UI outage
- Team disagreement about timing

**Decision authority:** Security Council only. No single team member can trigger cancel.

**If Security Council is split or unavailable:** Do not cancel unilaterally. The contract will either succeed normally or, if demand is sub-minimum, anyone can call `finalize()` (permissionless) after the deadline, which sets `refundMode = true` and activates `claimRefund()` for all participants. Forced cancel without quorum is not possible.

---

## 10. Decision Log Template

Every irreversible action must be logged here before it is executed. This is the audit trail.

### addSeed() log

| # | Timestamp | Actor | Hop-0 address | TX hash | Rationale | Seed count after |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| ... | | | | | | |

### launchTeamInvite() log

| # | Timestamp | Actor | Invitee address | Invitee hop (fromHop + 1) | TX hash | Rationale | Budget remaining |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| ... | | | | | | | |

### Finalization gas benchmark log

| Timestamp | Actor | Participant count | Gas estimate | Actual gas used | Notes |
|---|---|---|---|---|---|
| | | | | | |

### cancel() decision log

| Timestamp | Actor | TX hash | Emergency description | SC signers |
|---|---|---|---|---|
| | | | | |

---

## 11. Go/No-Go Checkpoints

### Checkpoint 1: Pre-launch (before calling `loadArm()`)

| Condition | Status | Owner |
|---|---|---|
| All pre-launch checklist items signed off | ☐ | Deployer |
| Contract deployed and verified | ☐ | Deployer |
| EIP-712 domain separator verified | ☐ | Deployer |
| ARM token deployed — constructor mints 1.8M ARM directly to crowdfund contract | ☐ | Deployer |
| Observer and committer URLs confirmed working | ☐ | Ops |
| Monitoring alerts active | ☐ | Ops |
| Security Council reachability confirmed | ☐ | Ops |
| Initial hop-0 list finalized | ☐ | ROOT |
| Announcement drafted and ready | ☐ | Ops |

**If any item is not ☐:** Do not proceed. Resolve first.

---

### Checkpoint 2: End of week 1 (before launch-team invite window closes)

| Condition | Status | Owner |
|---|---|---|
| All planned hop-0 participants added or explicitly deferred (documented) | ☐ | ROOT |
| Launch-team hop-1 budget accounted for (issued + reserved) | ☐ | ROOT |
| Launch-team hop-2 budget accounted for (issued + reserved) | ☐ | ROOT |
| Decision log entries complete for all addSeed/launchTeamInvite actions | ☐ | ROOT |
| `capped_demand` trend reviewed | ☐ | Ops |
| Observer graph reviewed for anomalies | ☐ | Ops |
| No active security concerns | ☐ | Security Council |

**If capped_demand trend suggests minimum raise is unlikely:** Do not cancel. Monitor through week 3.

---

### Checkpoint 3: Pre-finalization (after commitment deadline, before calling `finalize()`)

| Condition | Status | Owner |
|---|---|---|
| `block.timestamp > commitmentDeadline` | ☐ | Ops |
| `capped_demand` reviewed (if sub-minimum, finalize will set refundMode) | ☐ | Ops |
| `finalized == false` | ☐ | Ops |
| `cancelled == false` | ☐ | Ops |
| `finalize()` gas estimate verified (should be 3-5M under lazy settlement) | ☐ | Ops |
| Treasury standing by to verify proceeds | ☐ | Treasury |
| Participant announcement drafted for both success and refundMode outcomes | ☐ | Ops |

**If capped_demand < MINIMUM_RAISE:** Call `finalize()` anyway — it sets `refundMode = true`. Announce immediately.
