# Governance

### Implementation readiness

| Section | Status |
|---|---|
| Voting Power (checkpointing, delegation, quorum) | Ready |
| Proposal Lifecycle (standard/extended/signaling, bond, threshold) | Ready |
| Parameters | Ready |
| Scope (governable vs immutable) | Ready |
| Treasury Outflow Limits | Ready |
| Contract Upgrade Scope / Adapter Registry | Ready |
| Security Council (powers, veto, ratification, ejection) | Ready |
| Treasury Steward (role, budget, defeat quorum, compensation) | Ready |
| Wind-Down (trigger, sequence, redemption, post-wind-down) | Ready |
| Treasury Distributions (operational, surplus deployment, wind-down redemption) | Ready |
| Fee Structure | See FEE_STRUCTURE.md |
| Token Distribution | See ARM_TOKEN.md |

---

## Model

**Proposals fail by default unless they achieve majority quorum.**

Anyone can propose. Only proposals with genuine support pass.

---

## Voting Power

### How it works

ARM tokens vote directly — no locking required. Voting power equals your token balance at a fixed snapshot block, regardless of what you do with your tokens afterward.

**Token balances are checkpointed continuously.** Every time ARM moves — through a transfer, a claim, or a delegation change — the token contract records a new checkpoint for that address. When a proposal is created, the snapshot is fixed at `block.number - 1`. All voting power calculations for that proposal use the checkpoints at that block, permanently. Nothing that happens after the snapshot affects that vote.

This means:
- You can vote and then sell. Your voting power was already fixed.
- You cannot buy ARM after a proposal is created and use it on that vote.
- Atomic flash loan attacks are structurally impossible — borrowed tokens have no checkpoint history at the snapshot block. Short-term capital attacks (borrow → hold through snapshot → vote → return) require real capital exposure for 9+ days minimum (proposal delay + voting period). The defense model is detection and reaction, not prevention: outflow limits bound damage per window, visibility windows give the community time to mobilize, and the Security Council can veto during execution delay. As ARM liquidity deepens, time-weighted average balance (TWAB) voting may be introduced via governor upgrade to further raise the cost of short-term accumulation attacks.
- When tokens transfer, the sender's delegated voting power decreases and the recipient starts undelegated. Secondary market activity naturally refreshes delegation state.

### Delegation

**Voting power is inactive until delegated.** To participate in governance — either by voting directly or contributing your weight to a delegate — you must assign a delegatee. This is a one-time transaction that can be changed at any time.

| Option | Who votes | When to use |
|--------|-----------|-------------|
| Self-delegate | You vote directly | Active governance participants |
| Delegate to another address | Your delegate votes on your behalf | Passive holders who trust a representative |
| Delegate to abstain address | Tokens count toward quorum; no votes cast | Holders who want their weight in the denominator without participating |

Delegation is free to change at any time. Redelegating takes effect for proposals created after the next block.

**Votes can be changed during the voting period.** A voter may switch between FOR, AGAINST, and ABSTAIN at any time while voting is active. Only the final vote state at voting close counts. This encourages early participation — voters aren't penalized for updating their position as discussion evolves. **Votes cannot be withdrawn entirely** — once cast, the voter's weight counts toward quorum regardless of subsequent switches. This means quorum only increases during voting, preventing quorum manipulation (vote to push above threshold, then withdraw to drop below).

**One level of delegation only.** A delegate cannot redelegate to a third party. Voting power terminates at the delegatee.

### Delegation-at-circulation requirement

**Launch circulation paths enforce atomic delegation.** Both the crowdfund `claim(delegate)` and the revenue-lock `release(delegate)` require a `delegatee` parameter. Self-delegation is valid; it is still an explicit choice. ARM entering circulation through these paths is immediately active in the governance denominator.

**Treasury distributions do not enforce atomic delegation.** When governance approves a treasury transfer (ARM sent from the whitelisted treasury to a recipient), the recipient receives standard undelegated ARM. They must call `delegate()` themselves. Until they do, that ARM is circulating but vote-inert. This is a known property — the treasury transfer path is a standard ERC-20 transfer, not a `delegateOnBehalf` path. The practical impact is bounded: treasury distributions require governance approval (subject to outflow limits), and recipients are expected to delegate as part of participating in the protocol.

**If you plan to receive delegation from others:** call `delegate(yourAddress)` before those delegators claim. This establishes your checkpoint history.

### Known limitation: early delegation centralization

Delegation-at-circulation means every participant must choose a delegatee at claim time. In practice, most will delegate to whoever is visible and active in the early community. **3-5 early delegates holding majority voting power within weeks of launch is a likely near-term outcome, not a theoretical long-term risk.** This is a property of every Compound-style delegation system — early movers accumulate power because passive holders never redelegate.

Delegation persists until actively revoked. Original holders who set delegation at claim time and go dark give their delegates permanent voting weight with no expiry mechanism. Mitigation at launch relies on competitive redelegation dynamics — if a delegate behaves badly, active holders redelegate away — and on the crowdfund cohort being small and warm. A delegation expiry mechanism (e.g., delegations lapse after 6-12 months unless renewed) may be introduced via governor upgrade as the protocol matures.

A further limitation: once a delegate casts a vote, individual
delegators cannot override that vote on the specific proposal.
Redelegation only affects future proposals (created after the
next block). A delegator who disagrees with their delegate's
vote on an active proposal has no on-chain recourse for that
vote. Delegation override is a candidate for a future governor
upgrade (see §Future governance upgrades).

### Quorum denominator

Quorum is measured as a percentage of **circulating voting power at the snapshot block**.

In plain terms: quorum denominator = `totalSupply - treasury - excludedAddresses` at the snapshot block. This is all circulating ARM regardless of delegation status.

The ARM token's architectural enforcement (delegation-at-circulation for all primary paths) means nearly all circulating ARM is delegated in practice: crowdfund claims and revenue-lock releases both force delegation atomically via `delegateOnBehalf`. The only undelegated circulating ARM comes from treasury distributions where recipients haven't yet self-delegated — a small fraction that makes quorum slightly harder to reach (conservative deviation, not a risk).

**Included:**
- All claimed crowdfund tokens (delegated atomically at claim)
- Early network tokens that have cleared their revenue milestone and been released (delegated atomically at release)
- Any ARM distributed from treasury (regardless of whether the recipient has delegated — treasury transfers do not enforce atomic delegation)

**Not included:**
- Treasury ARM (excluded from denominator; `delegate()` reverts for treasury address)
- Revenue-locked early network tokens not yet unlocked
- Allocated-but-unclaimed crowdfund tokens (vote-inert until claimed)

Both the numerator (votes cast) and the denominator (circulating voting power) are snapshotted at proposal creation. A batch of revenue-milestone unlocks mid-vote cannot move the goalposts.

### Attack surface

**Accumulate-before-snapshot, vote, sell:** An attacker buys ARM before the snapshot block, votes, then dumps. Cost is real capital exposed during at minimum the 48-hour proposal delay plus the voting period — 9+ days at standard, 16+ days at extended. A persistent attacker can extract across multiple windows, not just one. The defense model is **detection and reaction, not prevention**: treasury outflow rate limits (see §Treasury Outflow Limits) bound damage per window, the proposal delay and execution delay provide visibility windows for the community to detect hostile proposals, and the Security Council can veto during execution delay. The protocol should maintain off-chain monitoring for hostile accumulation patterns (large purchases followed by delegation changes).

**Quorum suppression is structurally mitigated.** Because the quorum denominator includes all circulating ARM regardless of delegation status, a holder cannot shrink the denominator by refusing to delegate. An undelegated holder's ARM still counts toward the denominator — they just can't vote. The residual risk is a large holder who delegates to themselves but never participates in votes, inflating the denominator without contributing to governance. This is a natural delegation property, not an attack — the holder's ARM is available to any proposal that reaches quorum, and the holder can be out-voted by more engaged delegates.

---

## Proposal Lifecycle

```
1. DRAFT    → Proposer creates; bond posted for executable proposals (see §Proposal bond)
2. PENDING  → 48-hour visibility window (proposer can cancel; community sees it coming)
3. ACTIVE   → Voting open: FOR / AGAINST / ABSTAIN (votes changeable during this period)
              Standard:  7 days
              Extended: 14 days
4. OUTCOME  → DEFEATED (quorum not met, or majority AGAINST)
            → SUCCEEDED (quorum met + majority FOR)
5. QUEUED   → Execution delay — Security Council may veto during this window (see §Security Council)
              Standard: 48 hours
              Extended:  7 days
6. EXECUTED → On-chain, irreversible
```

**Signaling proposals** follow steps 1–4 only. They resolve at OUTCOME and do not enter QUEUED or EXECUTED states. No bond required. See §Signaling proposals.

**Executable proposals** follow steps 1–6. Bond posted at step 1 (waived pre-transfer-unlock).

### Proposal bond

A bond of **1,000 ARM** is posted at submission.

| Outcome | Bond treatment |
|---------|---------------|
| Passed | Unlocked immediately after passing |
| Quorum not met | Locked 15 days, then returned |
| Voted down (majority AGAINST) | Locked 45 days, then returned |

Bond is always returned — it is never permanently slashed. The lock period is the cost of a failed proposal, calibrated to the severity of the failure. **Signaling proposals are exempt from the bond requirement** — they have no execution risk and the bond would suppress the low-stakes coordination the feature exists for. See §Signaling proposals.

**Pre-transfer-unlock exception:** Posting a bond requires transferring ARM to the governance contract. While ARM transfers are globally restricted (see ARM_TOKEN.md §5), non-whitelisted holders cannot transfer — so bonds are technically impossible. They are also economically meaningless: "losing access" to non-transferable ARM has zero opportunity cost. **Before global transfer unlock, governance operates on proposal threshold only (5,000 delegated ARM). No bond is required.** This avoids a chicken-and-egg problem: the proposal to enable transfers must itself be creatable without a bond. The bond mechanism activates naturally once governance enables transfers.

### Proposal threshold

**5,000 ARM** (0.042% of 12M total supply) must be held at snapshot to submit a proposal. An address that cannot meet the threshold can receive delegation from others to qualify.

### Standard vs. extended classification

A proposal is automatically **extended** if it grants authority,
loosens constraints, or increases risk exposure:

* Fee parameter increases
* Treasury allocation via `distribute()` or `distributeETH()` exceeding 5% of current treasury balance (the 5% rule applies to the per-tx distribution channel only — `stewardSpend()` is governed by the per-token Steward Budget table; see §Treasury Steward)
* Treasury Steward election
* Security Council seat changes via governance
* Contract upgrades (governor, fee module, revenue counter)
* ARM token whitelist additions
* Expanding the qualifying revenue definition
* Treasury outflow rate limit increases or window extensions
* Quorum decreases
* Voting period decreases
* Execution delay decreases
* Proposal delay decreases
* Proposal threshold decreases
* Bond decreases
* Quorum floor decreases
* Steward budget increases (add token, increase per-token limit, extend window)

A proposal is **standard** if it revokes authority, tightens
constraints, or reduces risk exposure:

* Treasury Steward removal
* Fee parameter decreases
* Treasury outflow rate limit decreases or window reductions
* Quorum increases
* Voting period increases
* Execution delay increases
* Proposal delay increases
* Proposal threshold increases
* Bond increases
* Quorum floor increases
* Steward budget decreases (remove token, decrease per-token limit, shorten window)

All other proposals — including treasury allocations within 5%
and routine operational actions — are **standard**.

**Design principle: tightening is easy, loosening is hard.** Actions
that reduce the protocol's attack surface or revoke granted
authority should face lower governance friction than actions that
expand it. This mirrors the asymmetric activation delay on treasury
outflow parameters (see §Treasury Outflow Limits) and extends the
principle to the full proposal classification system.

**Mixed-direction actions remain extended.** Any mixed-direction parameter change defaults to Extended. If a proposal both loosens and tightens different parts of the same parameter set (e.g., fee schedule reshuffles, outflow limit increase with window decrease, steward budget limit increase with window decrease), the loosening component dominates for classification. Security Council replacement (simultaneously revoking one council and installing another) and contract upgrades (replacing logic entirely) are classified as extended regardless of intent, for the same reason.

**Classification mapping:**

| Setter / action | Extended (loosening) | Standard (tightening) |
|---|---|---|
| Fee parameters | Increase | Decrease |
| Treasury outflow limit | Increase limit or extend window | Decrease limit or shorten window |
| Quorum | Decrease | Increase |
| Voting period | Decrease (less scrutiny time) | Increase (more scrutiny time) |
| Execution delay | Decrease (less veto time) | Increase (more veto time) |
| Proposal delay | Decrease (less visibility time) | Increase (more visibility time) |
| Treasury Steward | Election | Removal |
| Proposal threshold | Decrease (easier to propose) | Increase (harder to propose) |
| Bond | Decrease (cheaper to propose) | Increase (more expensive to propose) |
| Quorum floor | Decrease (easier to reach quorum) | Increase (harder to reach quorum) |
| Steward budget (per-token limit / window) | Add token, increase limit, extend window | Remove token, decrease limit, shorten window |
| Whitelist addition | Always extended | — (no removal path) |
| Contract upgrade | Always extended | — |
| SC replacement | Always extended | — |
| Revenue definition expansion | Always extended | — |

Classification is determined mechanically by calldata and, where
direction matters, comparison of proposed values against current
on-chain state. Selector matching alone is insufficient for
directional parameters — the classifier must read the current
value and compare against the proposed value to determine whether
the change is loosening or tightening.

For classifications that depend on treasury-relative thresholds
(e.g., "allocation > 5% of treasury balance"), the reference value
must be fixed at proposal creation or queue time and stored with
the proposal. Classification must not vary with treasury balance
changes between creation and execution.

If any action in a batched proposal is classified as extended, the
entire proposal is extended.

**Note: veto ratification votes** (see §Security Council) are a fourth proposal category with distinct parameters — they are triggered automatically when the SC vetoes a queued proposal, have a fixed 7-day voting period, use standard quorum, and carry the unique side effect of SC ejection on AGAINST outcome. The governor contract must implement this as a separate proposal type alongside standard, extended, and signaling.

### Signaling proposals

A signaling proposal is a non-executable proposal used to measure token-holder preference. It follows the standard proposal lifecycle for submission, delay, snapshot, voting, and quorum, but has no execution phase, no queue, and no timelock delay. Its result is the final on-chain vote tally only.

**No direct protocol effect.** A passed signaling proposal does not authorize execution, does not bind the Security Council, Treasury Steward, or any contract role, and does not replace the requirement for a separate executable proposal where protocol action is desired. Signaling proposals create no execution rights, obligations, or automatic follow-up.

**Proposal kind is explicit on-chain.** The governor classifies proposals as `executable` or `signaling` — not inferred at runtime from empty calldata alone. This determines lifecycle behavior (execution phase skipped), bond rules, veto scope, and UI treatment. Implementation may encode signaling as empty target/calldata/value arrays, but the spec treats it as a distinct proposal type.

**How they work:**
- Proposer submits a signaling proposal with a `description` string containing the signaling text.
- Classification is always **standard** (7-day vote, 20% quorum) — since nothing executes, extended scrutiny adds no safety value.
- **Gate: proposal threshold only.** Pre-transfer-unlock: 5,000 ARM threshold, no bond (same as all proposals). Post-transfer-unlock: 5,000 ARM threshold, **no bond** — signaling proposals consume discourse, not operational attention or assets. Spam defense is the proposal threshold (5,000 ARM) and the 48h pending delay. If signaling spam becomes a problem, governance can introduce a per-proposer cooldown or signaling-specific bond via governor upgrade.
- Voting works identically: FOR / AGAINST / ABSTAIN, quorum check, vote changing during the voting period.
- **No QUEUED or EXECUTED state.** After the voting period ends, the proposal resolves to SUCCEEDED or DEFEATED based on quorum and majority. No timelock queue, no execution transaction.
- SC veto does not apply — there is nothing queued to veto.
- Signaling proposals do not count toward the steward circuit breaker's consecutive-low-participation tracker — they are not steward proposals.

---

## Parameters

| Parameter | Standard | Extended |
|-----------|----------|----------|
| Proposal threshold | 5,000 ARM | 5,000 ARM |
| Bond | 1,000 ARM | 1,000 ARM |
| Quorum | max(20% of circulating voting power, 100,000 ARM) | max(30% of circulating voting power, 100,000 ARM) |
| Proposal delay | 48 hours | 48 hours |
| Voting period | 7 days | 14 days |
| Execution delay | 48 hours | 7 days |
| Governance quiet period | 7 days post-crowdfund finalization | — (one-time only) |

**Quorum floor: 100,000 ARM.** Quorum is the greater of the percentage-based threshold and this absolute floor. This prevents governance passing on near-zero turnout regardless of how much ARM has been claimed and delegated at any given time. At the base raise of 1.2M ARM, 100,000 ARM represents ~8.3% of the crowdfund allocation — meaningful coordinated participation.

**Governance quiet period.** No proposals may be submitted for the first 7 days after crowdfund finalization. This is a **one-time constructor-set bootstrapping constant**, not a reusable governance parameter. It applies once and has no effect after expiry. Any emergency during this window is handled by the Security Council.

All reusable governance parameters listed above are themselves governable — loosening changes require an extended proposal, tightening changes require a standard proposal (see §Standard vs. extended classification). The one-time governance quiet period (7 days post-crowdfund finalization) is a constructor-set bootstrapping constant and is not governable — see §Governance quiet period.

---

## Scope

### Governable

| Category | Items | Proposal type |
|----------|-------|---------------|
| **Fees** | Fee increases (shield fee, yield fee, volume tiers, integrator terms) | Extended |
| **Fees** | Fee decreases | Standard |
| **Treasury operations** | `distribute()` / `distributeETH()` allocations ≤5% of treasury balance | Standard |
| **Treasury operations** | `distribute()` / `distributeETH()` allocations >5% of treasury balance | Extended |
| **Treasury operations** | `stewardSpend()` (within an authorized per-token Steward Budget) | Steward (pass-by-default; per-token budget is the gate, not the 5% rule — see §Treasury Steward) |
| **Parameters** | Batch windows, relayer config, yield sources | Standard |
| **Parameters** | Activity shaping defaults (transaction size constraints, rate limits, recommended ranges) | Extended |
| **Parameters** | Ingress normalization (standard ingress amounts, phase, custom deposit availability) | Extended |
| **Parameters** | Wind-down threshold, wind-down deadline | Standard |
| **Parameters** | Governance parameters — loosening changes (quorum decrease, voting period decrease, execution delay decrease, proposal delay decrease, proposal threshold decrease, bond decrease, quorum floor decrease) | Extended |
| **Parameters** | Governance parameters — tightening changes (quorum increase, voting period increase, execution delay increase, proposal delay increase, proposal threshold increase, bond increase, quorum floor increase) | Standard |
| **Parameters** | Treasury outflow rate limit increases or window extensions (loosening) | Extended |
| **Parameters** | Treasury outflow rate limit decreases or window reductions (tightening) | Standard |
| **Steward** | Treasury Steward election | Extended |
| **Steward** | Treasury Steward removal | Standard |
| **Steward** | Steward budget table — add token, increase limit, extend window (loosening) | Extended |
| **Steward** | Steward budget table — remove token, decrease limit, shorten window (tightening) | Standard |
| **Security Council** | SC address replacement via governance | Extended |
| **Adapters** | Authorize new adapters, deauthorize old adapters | Standard |
| **Upgrades** | Governor contract upgrade (UUPS, governance-gated) | Extended |
| **Upgrades** | Fee module upgrade (UUPS, governance-gated) | Extended |
| **Upgrades** | Revenue counter upgrade (UUPS, governance-gated) | Extended |
| **Revenue** | Non-stablecoin revenue attestation (`attestRevenue`) | Standard |
| **Revenue** | Expand qualifying revenue definition | Extended |
| **ARM token** | Add address to transfer whitelist (add-only, no removal) | Extended |
| **Signaling** | Non-executable preference vote (no execution, no bond) | Standard |

### Immutable

| Category | Items |
|----------|-------|
| **Cryptography** | ZK circuits, BN254 verifier |
| **Note structure** | Commitment format, nullifier derivation |
| **Privacy guarantees** | Shielded set membership, unlinkability |
| **Shielded pool** | Core pool contracts (inherited from Railgun) |
| **Crowdfund contract** | All parameters (see PARAMETER_MANIFEST.md §12) |
| **ARM token contract** | Non-upgradeable. No proxy. All invariants in ARM_TOKEN.md §12 are unconditional. |
| **Revenue-lock contract** | Milestone schedule and release logic. Beneficiaries must trust these cannot change. |
| **Wind-down contract** | Trigger mechanism (conditions are deterministic), treasury sweep authority, `setTransferable(true)` authority, and `windDownActive` flag on pause contract. Parameters (threshold, deadline) are governable but the trigger logic itself is immutable. |

---

## Treasury Steward

### Role

Elected role responsible for day-to-day treasury operations: recurring expenses, grants, and service payments in USDC.

### Authority

The steward operates within a **per-token budget table** — a governance-managed mapping of `token address → (budget limit, rolling window)`. Only tokens in the table can be distributed via steward proposals.

**Launch configuration:**

| Token | Budget limit | Rolling window |
|---|---|---|
| USDC | $60,000 | 30 days |

**Governance can modify the budget table. Loosening changes (add token, increase limit, extend window) require an extended proposal. Tightening changes (remove token, decrease limit, shorten window) require a standard proposal:**
- Add a new token with its own budget and window (e.g., "authorize steward to distribute up to 10,000 ARM per 30-day window")
- Increase an existing token's budget or extend its window (extended proposal)
- Decrease an existing token's budget or shorten its window (standard proposal)
- Remove a token from the table (revokes steward authority for that asset)

**Can:**
- Distribute tokens listed in the budget table, within their per-token rolling limits, via Treasury Steward proposals (pass-by-default, 7-day governance review window)
- Execute pre-approved recurring expenses within budget
- Fast-track coordination with Security Council on security-critical actions

**Cannot:**
- Distribute tokens not in the budget table — these require full governance proposals regardless of amount
- Exceed any per-token rolling limit
- Change fee rates or protocol parameters
- Grant custom integrator terms (requires governance)
- Exceed the treasury outflow rate limits (see §Treasury Outflow Limits) — steward spending counts against the aggregate rolling window in addition to the per-token steward budget

⚠️ At launch, only USDC is in the steward budget table. The $60,000/month limit is sized for approximately 20 months of operating runway on a base raise.

### Process

Treasury Steward proposals **pass by default** unless governance votes them down within a 7-day review window.

**Defeat condition:** Standard quorum (20% of circulating voting power or 100,000 ARM, whichever is greater) is reached AND a simple majority votes AGAINST. If quorum is not met, the proposal passes by default — the community isn't concerned enough to mobilize.

This inverts the normal proposal flow for routine operational spending: the steward acts unless the community objects, rather than requiring active support for every payment.

### Budget mechanics

- **Per-token rolling windows.** Each token in the budget table has its own rolling window (30 days at launch for USDC). Limits are measured over any trailing window period.
- **No carryover.** Unused budget does not accumulate. Each token's limit is always its configured amount per trailing window.
- **Multiple proposals may stack** within the same window, but their combined value per token cannot exceed that token's budget limit.
- **Steward spending counts against treasury outflow limits.** The per-token steward budget and the aggregate treasury outflow limits (§Treasury Outflow Limits) are not independent — steward proposals consume from the same rolling outflow window as governance proposals. A steward proposal can be within the steward's per-token budget but still revert at execution if it would breach the aggregate treasury outflow limit.
- **The 5% Extended classification rule does not apply to `stewardSpend()`.** That rule gates the per-tx `distribute()` / `distributeETH()` channel. The steward channel is pre-authorized via the per-token Steward Budget table — adding a token, increasing a limit, or extending a window already requires an Extended proposal (§Governable). Within an authorized budget, individual `stewardSpend()` proposals are governed by the budget table and the aggregate treasury outflow limits, not by per-tx 5% classification. Both gates are enforced at queue time: a `stewardSpend()` whose aggregate per-token amount exceeds either the steward budget limit or the effective outflow limit is rejected before reaching the timelock.

### Circuit breaker

**If 5 consecutive steward proposals have participation below 30%** (regardless of whether quorum was technically reached), the steward channel automatically pauses. No further steward proposals can be submitted until a standard governance proposal explicitly re-authorizes the steward channel (requires quorum + majority FOR). This prevents both governance apathy (nobody votes) and minimal-participation capture (an attacker votes just enough to clear quorum without genuine community engagement).

**Participation** = `(FOR + AGAINST + ABSTAIN votes cast) / circulating voting power at the proposal's snapshot block`. Abstain counts as participation. Changed votes count by final state only (each address's last vote before close). This uses the same denominator as quorum — circulating voting power snapshotted at proposal creation.

### Election

- Initial Treasury Steward: Core team (Knowable)
- Term: 6 months, renewable
- Election and re-election: Extended governance proposal
- Removal: Standard governance proposal, immediate effect

### Steward compensation

**No built-in compensation mechanism.** The steward role is operational authority, not a paid position. If a steward wants compensation, they submit a standard governance proposal (requires quorum + majority FOR) through a non-steward address — the same path as any community member requesting funds. Steward proposals (pass-by-default channel) cannot include payments to the steward's registered address (the address that holds the steward role on-chain). The treasury outflow limits and defeat mechanism are the real safeguards against steward self-dealing, not address filtering.

The initial steward (Knowable) is compensated via the team ARM allocation. No additional payment for the steward role at launch.

### Adding operational roles

Additional steward-like roles (e.g. a Protocol Steward for integrator and relayer operations) can be added via governance proposal deploying a new contract with bounded authority. No governance contract upgrade is required — new roles are additive grants of specific permissions. This path is open when genuine separation of people makes it operationally necessary.

---

## Security Council

3-of-5 multisig. Fast-response body for situations where the governance proposal cycle (7+ days) is too slow.

### Powers

| Power | Mechanism | Constraint |
|---|---|---|
| **Pause new shields** | On-chain pause flag on the shielded pool | Auto-expires after 24 hours. SC can re-invoke but each invocation is a visible on-chain event. Unshields are never pauseable — users can always exit. |
| **Veto queued proposal** | Cancel a passed proposal during its execution delay, before it executes | See §Veto Mechanism below. |
| **Crowdfund cancel** | Emergency cancel of the crowdfund pre-finalization | Pre-protocol-launch only. See CROWDFUND.md §cancel(). No ratification required. |

### Not in scope

The Security Council cannot:
- Execute arbitrary transactions
- Upgrade any contract
- Move treasury funds
- Change fee or governance parameters
- Pause unshields (users can always exit)
- Pause the governor itself
- Make permanent parameter changes of any kind

### Veto mechanism

When the Security Council vetoes a queued proposal:

1. **Proposal passes** with quorum during normal voting.
2. **SC vetoes** during the execution delay window. The proposal is cancelled. SC must publish a written rationale (off-chain, with on-chain hash for verifiability).
3. **A 7-day veto ratification vote begins automatically.** The question: "Uphold the Security Council's veto?"
   - **FOR (uphold veto):** The vetoed proposal is permanently cancelled. The SC acted correctly in the community's view.
   - **AGAINST (deny veto):** The original vetoed proposal is
     restored. The current Security Council multisig is ejected
     — its address is removed from the governor contract.
     Governance must elect a new SC via extended proposal. During
     the gap, no SC powers are available (no pause, no veto).

     The proposal is re-scheduled in the timelock with a fresh
     2-day delay (the timelock's minimum). Execution remains a
     separate transaction — restoration does not auto-execute.
     No re-submission is required. The community has voted twice
     (once to pass the original proposal, once to deny the veto).
   - **Quorum not met:** Veto stands by default. If the community can't mobilize to override, the SC's security judgment holds.
4. Ratification uses **standard quorum** (20% of circulating voting power or 100,000 ARM).

**The ejection consequence is the accountability mechanism.** The SC only vetoes when they're genuinely confident the community will back them — vetoing a proposal the community wanted means losing the seat. This replaces the need for a separate SC bond or punishment mechanism.

**Single-veto rule.** A restored proposal cannot be vetoed again.
This is enforced per-proposal — the governor sets a flag when a
veto ratification vote resolves to AGAINST. If a newly elected SC
attempts to veto the restored proposal, the call reverts. This
protection is scoped to the specific restored proposal instance,
not to its calldata. A future proposal with identical calldata
submitted under different circumstances is a new proposal and
may be vetoed normally.

### Composition

Core team (2), external security (2), community (1).

### Membership changes

**Routine rotation:** The SC manages its own signer composition via standard Gnosis Safe signer replacement. This keeps routine rotation off the governance proposal queue.

**Governance override:** Governance can replace the SC multisig address via extended proposal (`setSecurityCouncil(newAddress)` on the governor contract). This is the path used after an ejection or if the community loses confidence in the SC.

**Ejection (via denied veto):** The governor contract automatically removes the SC address when a veto ratification vote fails (majority AGAINST). The `setSecurityCouncil` slot is set to `address(0)`. During the gap, no SC powers are available (no pause, no veto). Anyone can submit an extended proposal nominating a new SC multisig address — the normal extended proposal path applies (48-hour delay, 14-day vote, 7-day execution delay). Governance should treat SC replacement as the highest priority during this window.

### Limitations

- All SC actions except crowdfund cancel require retroactive ratification or produce automatic ratification votes (veto path)
- Shield pauses auto-expire after 24h — if not renewed, the pause lifts automatically
- The SC has no spending authority, no parameter authority, and no upgrade authority

⚠️ Security Council membership must be confirmed and multisig deployed before the crowdfund opens.

---

## Token Distribution

**See `ARM_TOKEN.md` for canonical token behavior, allocation enforcement, transfer restrictions, and revenue-gated unlock mechanics.**

Summary (non-authoritative — `ARM_TOKEN.md` takes precedence):

| Allocation | % | Enforcement | Voting power |
|---|---|---|---|
| Crowdfund | 10–15% | Non-transferable until governance unlock; lazy settlement (aggregate finalization, per-user computation at claim time — see CROWDFUND.md) | Active once claimed and delegated |
| Early network | 20% | Single shared revenue-lock contract with per-beneficiary allocations. Covers launch team, ecosystem contributors, and reserve for future contributors. All subject to revenue-gated unlock. | Proportional to revenue-unlock % |
| Treasury | 65–70% | Governance-controlled; whitelisted for transfers | None — `delegate()` reverts for treasury address |

### Revenue-Gated Unlocks

Early network tokens unlock based on cumulative protocol fee revenue.

| Cumulative Revenue | % Unlocked |
|----|---|
| $10k | 10% |
| $50k | 25% |
| $100k | 40% |
| $250k | 60% |
| $500k | 80% |
| $1M | 100% |

**No time-based fallback.** If revenue never reaches $1M, tokens never fully unlock.

**What counts as revenue:**
- Shield fees (USDC and stablecoins) recognized through the fee-collector / RevenueCounter path (permissionless sync — see §Revenue Counter Mechanism)
- Yield fees (USDC and stablecoins) recognized through the same fee-collector / RevenueCounter path
- Non-stablecoin fees (ETH, etc.) require a governance proposal to attest the USD value at time of receipt and credit it to the RevenueCounter — avoids oracle dependencies while keeping the counter honest

Governance can expand the definition of qualifying revenue via extended proposal (see §Revenue Counter Mechanism).

### Revenue Counter Mechanism

A dedicated `RevenueCounter` contract holds a single monotonic `uint256 recognizedRevenueUsd` — the canonical cumulative revenue figure that the revenue-lock contract reads.

**Interface:**
```
function recognizedRevenueUsd() external view returns (uint256)
```

**How it gets updated:**

| Revenue type | Update path | Authority |
|---|---|---|
| Stablecoin fees (USDC) | Permissionless `syncStablecoinRevenue()` — reads a monotonic cumulative-receipts counter on the **fee-collector contract** (the contract that receives shield fees and yield fees). This is NOT a treasury balance read — treasury outflows would corrupt the count. The fee-collector exposes `cumulativeFeesCollected() returns uint256` and only increments when fees are received. `syncStablecoinRevenue()` reads this value and updates the revenue counter accordingly. | Anyone can call |
| Non-stablecoin fees (ETH, etc.) | Governance proposal attests a new cumulative total via `attestRevenue(uint256 newCumulativeUsd)` | Governance (standard proposal) |

**Properties:**
- **Monotonic by contract.** `attestRevenue(newValue)` requires `newValue >= recognizedRevenueUsd`. The counter can never decrease. A governance mistake that attests the same value twice is harmless (no-op).
- **Cumulative, not delta.** Governance attests a new total, not an increment. This is idempotent — attesting "$50,000" twice doesn't double-count.
- **Attestations must reference verifiable on-chain receipts.** Non-stablecoin revenue attestation proposals should include the transaction hashes of the fee receipts being credited and use the observable market price at transaction time (e.g., ETH/USD price at the block the fee was received). The attested value must be auditable and grounded in market data — not a subjective interpretation.
- **Expanding the qualifying revenue definition requires an extended proposal** (14-day vote, 30% quorum, 7-day execution delay). This is treated as quasi-monetary policy because revenue unlocks control team token supply timing.
- **The revenue-lock contract reads this counter.** The lock has an immutable reference to the `RevenueCounter` address, set at deployment. It calls `recognizedRevenueUsd()` when a beneficiary requests release, compares against the milestone table, and releases the entitled percentage.
- **The counter is governance-upgradeable** (UUPS, governor as upgrade authority). The lock reads a fixed proxy address whose implementation can be upgraded by governance to handle new fee types — but the interface (`recognizedRevenueUsd() returns uint256`) never changes. The lock doesn't know or care about upgrades behind the proxy.

**Events:**
```
RevenueUpdated(uint256 cumulativeRevenue, uint256 previousRevenue)
```
Emitted on every update — both `syncStablecoinRevenue()` and `attestRevenue()`. Monitoring reads this event from the RevenueCounter contract address, not from the ARM token.

**Revenue counter appears in the Contract Upgrade Scope table as a governance-upgradeable module.**

---

## Fee Structure

**See `FEE_STRUCTURE.md` for canonical fee specification** — shield fees, yield fees, volume tiers, integrator terms, custom terms, on-chain queries, and events.

Summary (non-authoritative — `FEE_STRUCTURE.md` takes precedence):
- Shield (deposit): Armada take (40–50 bps, volume-tiered) + integrator fee (self-set + bonus)
- Yield redemption: 15% of yield to treasury
- All other operations (shielded transfer, swap, lend, unshield): free
- Fee increases require an extended governance proposal; fee decreases require a standard proposal — steward has no discretion over fee rates in either direction

---

## Relayer Economics

**See `FEE_STRUCTURE.md` for relayer fee details.**

Summary: Relayers set their own fees (gas cost + markup). No protocol cut. Users can self-relay to avoid relayer fees.

---

## Treasury Distributions

### Pre-wind-down (operational)

Treasury movements are executed via governance proposal. The governor/timelock executes approved proposals on-chain.

- **Steward channel:** USDC payments up to $60k/rolling-30-days via pass-by-default proposals. See §Treasury Steward.
- **Standard governance proposals:** Any treasury distribution (ARM, USDC, ETH, other assets) can be proposed through normal governance. Subject to treasury outflow limits (§Treasury Outflow Limits).

### Surplus deployment (future)

When protocol revenue consistently exceeds operational needs, governance may deploy surplus treasury resources. **No mechanism is predetermined.** The appropriate approach depends on protocol maturity, revenue scale, ARM liquidity depth, and governance priorities at the time.

**Defining "operational needs":** Operational needs include committed expenses (team compensation, infrastructure, audits, integrator incentives) and a target runway buffer. Revenue exceeds operational needs when projected runway remains above the target buffer after the proposed allocation. Governance should establish and maintain a target runway (e.g., 12-24 months of committed expenses) as the threshold below which surplus deployment is inappropriate.

**Wind-down as termination mechanism.** If ARM holders vote to wind down the protocol, remaining non-ARM treasury assets are distributed proportionally to ARM holders. This is a termination mechanism — it provides an orderly exit if governance decides the protocol should not continue. It is not a price floor, a guaranteed return, or an arbitrage mechanism. Wind-down requires governance coordination, quorum, and execution time.

**Available options (individually or in combination):**

**Treasury accumulation.** Builds reserves and extends operational runway. Most appropriate in early stages or uncertain conditions. This is the default — surplus stays in the treasury until governance actively decides otherwise.

**ARM buybacks.** Governance may vote to deploy surplus USDC to acquire ARM from the market, reducing circulating supply. Should be market-aware and conditional (e.g., only execute when price is below a moving average) — not fixed-schedule. See MAB (Market-Aware Buyback) architecture as a reference execution engine. **Buybacks should not be used when:** treasury reserves fall below the runway target, liquidity conditions make execution inefficient (high slippage), or there is evidence of sustained sell pressure overwhelming buys (the buyback becomes exit liquidity, not market formation).

**Direct surplus distribution.** Governance may vote to distribute surplus treasury assets (e.g., USDC) to delegated ARM holders. This is a governance decision requiring tokenholder approval. Appropriate only when revenue meaningfully exceeds operational needs and distribution size justifies gas and coordination costs. At low revenue levels, per-holder distributions may be negligible relative to claim costs. **Only delegated ARM participates in distributions — undelegated tokens are excluded.** Self-delegation counts.

**Phase guidance for governance:**

| Phase | Conditions | Recommended approach |
|---|---|---|
| Early (post-launch) | Revenue ≤ operational needs | Treasury accumulation. All revenue funds growth and operations via steward budget. |
| Growth | Revenue exceeds operations but ARM liquidity is thin | Treasury accumulation + optional conditional buybacks for market formation (not price defense). |
| Mature | Durable revenue surplus, meaningful ARM liquidity | Governance has more options for surplus deployment. Buybacks may complement distribution. Governance decides the mix. |

These are guidelines, not constraints. Governance retains full discretion. The phases reflect the principle that surplus deployment approaches should match protocol maturity — premature buybacks or distributions divert treasury resources from growth during the phase where those resources compound most aggressively.

### Wind-down (redemption)

See §Wind-Down for the redemption mechanism. ARM holders deposit ARM into the redemption contract and receive pro-rata shares of non-ARM treasury assets. Permissionless, no governance required.

**Treasury steward details:** See §Treasury Steward above for budget mechanics, defeat quorum, and process. Steward spending counts against treasury outflow limits (see §Treasury Outflow Limits).

### Operational norms

Large treasury proposals (especially those approaching outflow limits) should be socialized with the community before formal submission. The governance mechanism provides detection windows (proposal delay, voting period, execution delay), but detection only converts to action if the community is aware. Off-chain coordination (forum posts, delegate discussion) is expected for significant treasury operations.

---

## Wind-Down

### Trigger

**Two trigger paths:**

1. **Automatic (permissionless):** Anyone can call `triggerWindDown()`. The contract checks: `block.timestamp > windDownDeadline && cumulativeRevenue < revenueThreshold`. If both conditions are true, wind-down activates. If either is false, the call reverts. No privileged caller needed — the conditions are deterministic.

2. **Governance vote:** Governance can trigger wind-down at any time via standard proposal, regardless of revenue or deadline.

| Parameter | Default | Governable |
|-----------|---------|------------|
| Revenue threshold | $10,000 cumulative | Yes (standard proposal) |
| Deadline | December 31, 2026 | Yes (standard proposal) |

### Sequence

1. Wind-down triggers (automatic or governance vote)
2. **ARM transfers are enabled (or confirmed already enabled)** — wind-down ensures `transferable == true` on the ARM token as a post-condition. If governance previously enabled transfers via a separate proposal (the spec-expected post-crowdfund unlock), wind-down skips the redundant `setTransferable(true)` call; otherwise wind-down flips it during the trigger transaction. Either way, holders must be able to move ARM to redeem their treasury share.
3. **Revenue counter and revenue-lock ratchet are frozen.** The wind-down contract calls `freeze()` on the `RevenueCounter` (rejecting further `attestRevenue` and `syncStablecoinRevenue` calls) and `freezeAtWindDown()` on the `RevenueLock` (locking `maxObservedRevenue` after one final ratchet update against the just-frozen counter). The unlock-percentage milestone state at trigger time becomes the permanent fixed point. This stabilizes the redemption denominator: subsequent `release()` calls do not change `lockedAtWindDown()`, so claim/release timing cannot shift the ratio between sequential redemptions.
4. Shielded pool enters withdraw-only mode immediately — `shield()` and shielded `transfer()` disabled; `unshield()` always available **indefinitely with no deadline**. There is no exit window — users can withdraw at any time, forever.
5. **Governance ends.** The full proposal lifecycle freezes — no new proposals, and pre-trigger Succeeded/Queued proposals cannot progress. `governor.queue` and `governor.execute` reject any call once `windDownActive`. This guarantees treasury ARM cannot move post-trigger via a pre-existing distribute / stewardSpend, which would otherwise break the redemption contract's pro-rata invariant. Voting on already-Active proposals can complete on-chain (state transitions to Succeeded), but those proposals simply cannot be queued. All remaining actions are permissionless (redemption, unshielding).
5. **Non-ARM treasury assets are swept to the redemption contract** via a permissionless `sweepToken(address token)` function on the wind-down contract. Anyone can call this function for any ERC-20 token address after wind-down triggers — it transfers the treasury's full balance of that token to the redemption contract. **`sweepToken(ARM)` reverts** — ARM cannot be swept. Treasury ARM remains locked permanently. Multiple calls (one per token) are needed to sweep all assets. Native ETH is swept via a separate `sweepETH()`. The wind-down contract has pre-authorized authority over the treasury for this purpose. No manual multisig action required — community members or participants can sweep whatever tokens they know about.
6. Treasury ARM has no distribution mechanism after wind-down — it remains locked permanently.

### Redemption mechanism

A **redemption contract** holds the treasury's non-ARM assets after wind-down. ARM holders deposit ARM into the contract and receive their pro-rata share of treasury assets in return.

**How it works:**
- Holder sends ARM to the redemption contract
- The contract calculates: `holderShare = depositedArm / circulatingSupply × remainingTreasuryAssets`
- The contract sends the holder their share of each treasury asset (USDC, ETH, etc.)
- The deposited ARM is locked in the redemption contract permanently (not burned — the ARM token has no burn function)

**Circulating supply** for the denominator includes all ARM that is economically entitled to holders, regardless of whether it has been claimed or released into a wallet. Entitlement is derived from allocation math, not raw contract balances:

```
circulatingSupply = ARM.totalSupply()
                  - ARM.balanceOf(treasury)
                  - ARM.balanceOf(redemptionContract)
                  - revenueLock.lockedAtWindDown()
                  - crowdfundUnsoldInContract
```

Where:
- **`revenueLock.lockedAtWindDown()`** = `totalAllocation × (10000 − unlockBpsAtWindDown) / 10000`. The locked (unvested) portion. Frozen at wind-down trigger so the value is stable across the redemption window. The vested portion stays in the denominator: beneficiaries can call `release()` and then redeem with no fairness penalty.
- **`crowdfundUnsoldInContract`** = `ARM.balanceOf(crowdfundContract) − crowdfundContract.armStillOwed()`. The unsold portion still in the crowdfund (will eventually be swept to treasury). Computed dynamically — once the unsold portion is swept via `withdrawUnallocatedArm`, this drops to 0 and the treasury balance subtraction picks it up. Allocated-unclaimed ARM stays in the denominator: participants can call `claim()` and then redeem with no fairness penalty.

The treasury, redemption contract, RevenueLock, and Crowdfund addresses are **hardcoded** in the redemption contract — no registry, no governance-managed list. The revenue-gated lock mechanism is a one-time launch construct (see REVENUE_LOCK.md §11), so no future lock contracts need to be accounted for. Custom grants post-transfer-unlock are standard treasury transfers, not lock contracts.

Participants can still call `claim()` after wind-down and then redeem. The denominator already accounts for their entitled-unclaimed ARM, so claim timing does not affect payout fairness. As holders redeem, the redemption contract's ARM balance grows and its portion is excluded from the denominator, ensuring correct pro-rata math for sequential redemptions.

**Properties:**
- **Permissionless.** No governance vote needed. No snapshot. No merkle tree. No claim window. Deposit ARM, receive your share, whenever you want.
- **Self-service.** Each holder decides when to redeem. No coordination required.
- **Sequential correctness and claim invariance.** Claiming or releasing ARM does not change circulating supply. Before a claim/release, entitled ARM is counted as circulating (included in the denominator via allocation math, not the contract balance). After a claim/release, the same ARM is in a wallet and still counted as circulating. Redemption outcomes are therefore independent of claim/release timing. Early and late redeemers receive the same per-ARM payout regardless of whether revenue-lock beneficiaries have called `release()` or crowdfund participants have called `claim()`.
- **No burn required.** ARM deposited into the redemption contract is locked permanently. The denominator calculation excludes it, so the math stays correct.

### Who receives treasury distribution

Pro-rata to all **circulating** ARM holders on **non-ARM treasury assets only**.

**Circulating (can redeem):**
- Crowdfund tokens (claimed)
- Released early network tokens (released from revenue-lock contract)
- Any ARM previously distributed from treasury

**Cannot redeem:**
- Revenue-locked early network tokens not yet released (still in the lock contract — the lock contract cannot call the redemption contract)
- Treasury ARM (locked permanently)

Those who paid for tokens have priority in failure scenarios. Locked tokens only unlock if protocol earns revenue — if the protocol failed before earning revenue, those tokens stay locked and cannot participate in redemption.

### Post-wind-down

**Governance is permanently disabled.** The full proposal lifecycle stops — `propose`, `proposeStewardSpend`, `queue`, and `execute` all reject calls once `windDownActive` is set. No new proposals, no in-flight proposals can queue, no queued proposals can execute. The steward role is functionally inert: no steward proposals can queue or execute, even if pre-trigger proposals reached the Succeeded state. `TreasurySteward.currentSteward()` may continue to report the elected address until the 180-day term naturally expires; the role's authority over governance is gone. The Security Council retains a single non-renewable 24h pause authority only — it can invoke one pause on the shielded pool (in case an adapter issue affects user withdrawals), but the pause auto-expires after 24h and cannot be renewed post-wind-down. **Enforcement:** as part of `triggerWindDown()`, the wind-down contract sets a `windDownActive` flag on the pause contract. The pause mechanism checks: if `windDownActive && pauseAlreadyInvoked`, revert. This prevents the SC from indefinitely pausing the pool without accountability, since the normal ratification mechanism depends on governance being active. **Pre-trigger pause bleed-through:** if an SC pause is active when `windDownActive` flips, that pause counts as the post-wind-down pause (`pauseAlreadyInvoked → true`) so the SC cannot issue a fresh post-trigger pause once it expires. This bounds total continuous unshield blocking across the trigger by the residual of the active pre-trigger pause (≤24h), not the chained pre+post total (~48h).

All remaining actions are permissionless:
- ARM holders redeem via the redemption contract (no deadline)
- Shielded pool users unshield indefinitely
- Revenue-lock beneficiaries can still call `release()` if milestones were previously reached

---

## Treasury Outflow Limits

Aggregate rolling-window limits on treasury outflows. These are the primary defense against governance capture — even a successfully passed malicious proposal can only extract limited value per window.

### USDC outflow

| Parameter | Value | Governable |
|---|---|---|
| Rolling window | 30 days | Yes — extensions require extended proposal; reductions require standard |
| Limit | $100,000 or 10% of USDC in treasury, **whichever is greater** | Yes — increases require extended proposal; decreases require standard |
| Minimum floor | $50,000 (governance cannot reduce below this) | No — immutable |

### ARM outflow

| Parameter | Value | Governable |
|---|---|---|
| Rolling window | 30 days | Yes — extensions require extended proposal; reductions require standard |
| Limit | 250,000 ARM or 3% of ARM in treasury, **whichever is greater** | Yes — increases require extended proposal; decreases require standard |
| Minimum floor | 100,000 ARM (governance cannot reduce below this) | No — immutable |

### How limits work

- **Aggregate, not per-proposal.** All treasury outflows within a rolling 30-day window count against the same limit — governance proposals, steward proposals, and any authorized module (e.g., future buyback contract).
- **Per-asset tracking.** USDC and ARM limits are tracked independently. A large USDC outflow does not consume ARM budget or vice versa.
- **Temporarily blocked proposals revert at execution.** If a queued proposal fits within the effective outflow limit but exceeds the currently available budget because of recent outflows, execution reverts and may be retried later once the rolling window has created room. Proposals whose aggregate spend exceeds the effective outflow limit itself are rejected earlier by the queue-time feasibility check (see below).
- **The percentage scales with treasury size.** On a $1M treasury, the USDC limit is $100k (floor binding). On a $5M treasury, the limit is $500k (10% binding). This allows the protocol to grow without constant parameter adjustments.
- **The minimum floors are immutable.** Governance can raise the percentage or the floor, but cannot reduce below $50k USDC or 100k ARM. This prevents captured governance from weaponizing the outflow controls by setting them so low that legitimate treasury operations become impractical. Loosening attacks are handled separately by the delayed-activation mechanism.

**Queue-time feasibility check.** When a proposal is queued, the governor checks whether any treasury spend action in the proposal exceeds the current effective outflow limit for that token. Spend amounts are aggregated per token across all actions in a batched proposal. If the aggregate exceeds the effective limit, the queue call reverts — the proposal can never execute under current parameters and should not occupy the timelock queue indefinitely. This check compares against the effective limit (the ceiling), not the available budget (ceiling minus recent outflows). A proposal that fits within the limit but exceeds the currently available budget is allowed to queue and can be executed later when the rolling window creates room. This check uses the current effective limit at queue time. A proposal that is impossible under current parameters but could become possible later due to treasury growth or a later governance limit change must be re-submitted.

**Retry behavior for temporarily blocked proposals.** A queued proposal whose spend fits within the effective limit but exceeds the currently available budget will revert at execution time. The revert is atomic — no state changes persist, and the proposal remains in Queued state in both the governor and the timelock. Anyone can retry execution permissionlessly once the rolling window has created enough room. Queued proposals do not expire — they remain retryable indefinitely. In the worst case (a single large prior spend near the limit), the wait may be up to the full window duration (30 days) before earlier outflows age out of the rolling window.

### Asymmetric activation delay for outflow parameter changes

All outflow parameter changes are asymmetric:

- **Tightening changes take effect immediately.** Any change that reduces spending capacity is a security-improving action and is never delayed.
- **Loosening changes are subject to a 24-day activation delay.** Any change that increases spending capacity is written to a pending slot and activates only after the delay expires. Treasury outflow checks read active parameters, not pending ones.

The 24-day activation delay exceeds the maximum Extended proposal governance cycle (2-day proposal delay + 14-day voting period + 7-day execution delay = 23 days). Governor timing parameter setters enforce that the Extended cycle remains strictly shorter than the activation delay (`_maxExtendedCycle() < LIMIT_ACTIVATION_DELAY`).

This structurally prevents two attack patterns:

- **Atomic batch attack:** a single proposal cannot batch a parameter loosening and a treasury drain. The drain executes against the old (tighter) active parameters and reverts.
- **Pre-execution overlap:** a drain proposal submitted *before* the parameter-loosening proposal executes will complete its own governance cycle before the pending change activates, so it executes against the old parameters and reverts.

Under governance capture and current timings, the minimum drain timeline is approximately 47 days across two separate Extended proposals, each with an independent Security Council veto opportunity and 24 days of publicly-visible pending state between them.

**Residual gap:** a drain proposal submitted *after* the parameter-loosening proposal executes but *before* the pending change activates can be timed to execute at or after activation and benefit from the loosened parameters. Closing this gap requires proposal-time snapshotting of outflow parameters, where treasury-spend proposals are evaluated against the parameters active when they were queued rather than when they execute. This is planned as a post-launch governor upgrade and would extend the minimum drain timeline to approximately 70 days across two fully separated governance cycles.

The pending parameter values are publicly readable from storage at all times. During the 24-day activation window, any token holder or monitoring system can observe that a loosening change is pending. External monitoring infrastructure subscribes to `OutflowLimitIncreaseScheduled`, `OutflowLimitActivated`, and `OutflowLimitDecreased` events for real-time visibility.

Governance can cancel a pending loosening by passing a proposal that sets the parameter to the current active value or lower. Since this is a tightening change, it takes effect immediately and clears the pending state.

If governance submits a new loosening change while a previous one is still pending, the new value replaces the pending change and resets the 24-day activation timer. Governance's most recent decision is authoritative.

**Upgradeability caveat:** `ArmadaTreasuryGov` is UUPS-upgradeable via governance proposal. A malicious governance upgrade could replace the contract logic including the delay mechanism itself. The defense against malicious upgrades is the Security Council veto during the upgrade proposal's execution delay window, combined with community review of new implementations. This is a fundamental property of upgradeable contracts, not a limitation specific to the outflow delay mechanism.

---

## Contract Upgrade Scope

| Contract | Upgradeable? | Mechanism | Why |
|---|---|---|---|
| **ARM token** | No | — | Trust bedrock. All invariants are unconditional. See ARM_TOKEN.md §9. |
| **Treasury** | Implementation TBD (confirm with Ian) | Controlled by governor/timelock | All outflows require governance proposal execution (standard or steward channel), subject to treasury outflow limits. The treasury address is immutable in all contracts that reference it (fee module, yield vault, crowdfund, wind-down contract). The wind-down contract has pre-authorized sweep authority. The treasury cannot delegate ARM (token-enforced: `delegate()` reverts for treasury address). If the treasury is a contract (not the timelock itself), its owner/controller must be the timelock. |
| **Crowdfund contract** | No | — | Non-upgradeable. All parameters are constructor-set. Post-finalization, all privileged functions are permanently inactive. See CROWDFUND.md. |
| **Redemption contract** | No | — | Permissionless post-wind-down. Four excluded addresses hardcoded in constructor (treasury, revenue-lock, crowdfund, redemption). No admin, no governance interaction. |
| **Revenue-lock contract** | No | — | Beneficiaries must trust the milestone schedule and release logic cannot change. |
| **Wind-down contract** | No | — | Trigger conditions must be deterministic and immutable. Has pre-authorized authority to: sweep non-ARM treasury assets to redemption contract (permissionless per-token), call `setTransferable(true)`, and set `windDownActive` flag on pause contract. Parameters (threshold, deadline) are governable, but the trigger mechanism itself cannot be replaced. |
| **Governor** | Yes | UUPS, governance-gated via timelock | Must be extensible — new proposal types, bond mechanics, steward logic. Extended proposal required. |
| **Fee module** | Yes | UUPS, governance-gated via timelock | Fee tiers, integrator terms, yield fee rates. New fee types as protocol evolves. Extended proposal required. |
| **Revenue counter** | Yes | UUPS, governance-gated via timelock | Interface is fixed (`recognizedRevenueUsd() returns uint256`). Implementation can be upgraded to handle new revenue types. The immutable revenue-lock contract reads the proxy address. **Note:** if the fee module is replaced (new proxy address), the RevenueCounter implementation must be upgraded to point at the new fee-collector — these upgrades must be coordinated. |
| **Adapters** (CCTP, Aave, future) | Not upgradeable — additive registry | Governor maintains authorized adapter registry | New adapters are deployed as independent contracts and authorized via governance proposal. Old adapters can be deauthorized or set to withdraw-only. Each adapter is independently auditable. See §Adapter Registry. |
| **Shielded pool** (Railgun) | No | — | Core privacy infrastructure. Immutable. |

### Governance-critical upgrade lifecycle (future governor upgrade — not implemented at launch)

**Implementation status: this section specifies a planned post-launch governor upgrade. It is NOT part of the initial deployment. The initial governor uses the standard Extended proposal path for all upgrades. This mechanism will be implemented via UUPS governor upgrade after the initial audit cycle.**

Governor, timelock, and treasury contract upgrades are the highest-risk governance actions — a malicious governor upgrade can replace all other safety mechanisms. These upgrades will use a two-stage approval process that requires governance to decide twice, with a mandatory review period between decisions.

**Scope:** Applies to UUPS upgrades targeting:
- Governor contract
- TimelockController (if upgradeable)
- ArmadaTreasuryGov

Fee module and revenue counter upgrades use the standard Extended proposal path. They are high-risk but cannot directly bypass governance itself.

**Stage 1 — Upgrade Approval**

An Extended governance proposal that approves an exact upgrade package. Stage 1 does not perform the upgrade. It records the approved package, defined by:
- Target proxy address
- New implementation address
- Implementation code hash (keccak256 of deployed bytecode)
- Initializer / migration calldata hash (if any)
- Expiry timestamp (stage 2 must be ratified before this)

The package hash binds all elements. If any element changes, a new stage 1 proposal is required.

Stage 1 follows the standard Extended lifecycle: 48-hour proposal delay, 14-day voting period, 30% quorum. The Security Council may veto during the execution delay.

**Mandatory Review Period**

After stage 1 passes and executes (recording the approved package), a mandatory review period begins. Stage 2 cannot be proposed until this period expires.

Review period: 14 days minimum. This is a fixed constant, not a governance parameter — governance cannot shorten it.

During this period, the community inspects the exact implementation code at the approved address. The implementation is deployed and verifiable on-chain before stage 2 begins.

**Stage 2 — Upgrade Ratification**

A special-purpose ratification proposal that references the stage 1 package hash. Stage 2 can only execute the exact approved package — no modifications.

Stage 2 follows the Extended lifecycle with its own independent vote: 48-hour proposal delay, 14-day voting period, 30% quorum, 7-day execution delay. The Security Council may veto.

On successful execution, stage 2 performs the actual UUPS upgrade.

**Invariants:**
- Ratification cannot alter the upgrade payload
- A new implementation address requires a new stage 1
- Both stages are independently vetoable by the SC
- If stage 2 is not ratified before the expiry timestamp, the approval lapses and a new stage 1 is required
- If stage 2 fails (quorum not met or majority against), the approval is permanently cancelled

**Minimum timeline:**

Stage 1: 2-day delay + 14-day vote + 7-day execution = 23 days
Review period: 14 days
Stage 2: 2-day delay + 14-day vote + 7-day execution = 23 days
Total: ~60 days minimum from first proposal to upgrade

This is deliberately slow. Governance-critical upgrades should be the hardest action in the system to execute.

### Adapter Registry

The governor maintains a registry of authorized adapter addresses. Adapters interact with the shielded pool and external protocols (Aave, CCTP, future yield sources, future relayer infrastructure).

**Adding a new adapter:** Deploy the adapter contract independently. Submit a standard governance proposal to authorize it (`authorizeAdapter(address)`). Once authorized, the adapter can interact with the protocol. Existing adapters remain active — new additions are additive, not replacements.

**Removing an adapter:** submit a standard governance proposal to deauthorize (`deauthorizeAdapter(address)`). For adapters with user positions (e.g., yield adapter with deposits), deauthorization should set the adapter to **withdraw-only mode** rather than immediate full deauthorization — users need time to exit their positions.

**Replacing an adapter:** Deploy the new version, authorize it, then deauthorize the old one (in withdraw-only mode). Both run in parallel during the transition.

This is the model for handling EIP-8141 (new precompiles for proof verification): deploy a new relayer/proving adapter that uses the new precompiles, authorize it via governance, old adapter stays active for in-flight operations.

---

## Known Limitations and Future Evolution

### Governance misalignment at launch

Token governance represents ARM holders. But Armada's value comes primarily from integrators and the volume they bring. Integrators have zero explicit governance power — their influence is indirect (threatening to leave if fee policy is unfavorable). This misalignment is acknowledged and expected to evolve. Potential future mechanisms include integrator-weighted veto on fee changes, integrator advisory council, or dual-quorum requirements for integration-affecting proposals. None of these are specified or required at launch.

### Governance reality

**At launch, governance security depends on the integrity of the top delegates, not on token distribution.** Power concentrates in 3-5 early delegates. Governance is slow (7-14 day cycles). Protection comes from outflow limits and visibility windows, not from voting mechanics. The system is designed to degrade predictably (bounded leakage, slow degradation) rather than catastrophically (full drain, permanent capture). This is intentional — the outflow limits and SC veto are the real safety rails, and governance voting is the steering mechanism within those rails.

### Future governance upgrades (governor is UUPS-upgradeable)

The following mechanisms are candidates for governance upgrades as the protocol matures. None are required at launch:

- **Time-weighted average balance (TWAB) voting.** Voting power = min(balance at snapshot, time-weighted average over X days). Raises the cost of short-term capital attacks. Becomes important as ARM liquidity deepens and lending markets emerge.
- **Delegation expiry.** Delegations lapse after 6-12 months unless renewed. Prevents permanent power accumulation by early delegates.
- **Integrator governance participation.** Volume-weighted integrator input on fee and integration policy.
- **Surplus deployment mechanisms.** Buyback execution engine (MAB), direct fee distribution, or hybrid — governance decides based on conditions. See §Treasury Distributions.
- **Delegation override (liquid democracy).** Allow delegators
  to override their delegate's vote on a specific proposal after
  the delegate has cast it. The delegator's portion of voting
  power is subtracted from the delegate's vote and applied
  independently. This addresses the limitation that once a
  delegate votes, delegators who disagree have no recourse on
  that proposal — redelegation only takes effect for future
  proposals. Implementation requires tracking each delegator's
  contribution to a delegate's snapshot balance, decrementing
  already-cast votes, and handling gas costs that scale with
  override count. Related designs exist in liquid-democracy-style
  governance systems. This is a governor upgrade, not a token
  change.
- **Two-stage governance-critical upgrades.** Governor, timelock, and treasury upgrades will require a two-stage approval + ratification process with mandatory 14-day review period between stages and payload-hash binding. The initial deployment uses the standard Extended proposal path. See §Governance-critical upgrade lifecycle. This is the highest-priority post-launch governor upgrade.
