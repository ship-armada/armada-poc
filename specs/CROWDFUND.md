# Armada Crowdfunding Spec

## Overview

Armada bootstraps governance through a word-of-mouth whitelist crowdfund. The allocation mechanism is algorithmic and predeclared. Once the commitment window opens, participant allocations are determined entirely by the rules of the contract, not by launch team discretion. The initial network shape (who is added as a hop-0 participant, and who the launch team invites directly) is determined by the launch team before and during the window. This is intentional and disclosed.

### Parameters

| Parameter | Value |
|---|---|
| Purpose | Governance bootstrapping |
| Minimum fund | 1,000,000 USDC ($1.0m) |
| Base fund | 1,200,000 ARM ($1.2M) |
| Max fund (elastic) | 1,800,000 ARM ($1.8M) |
| Expansion trigger | 1,500,000 USDC ($1.5M) in capped demand |
| Percent of supply | 10 - 15% |
| Price | 1.00 USDC ($1.00) per ARM |
| Timing | Testnet product |

---

## Token Distribution

**Total supply: 12,000,000 ARM**

| Allocation | ARM | % | Unlock | Voting Power |
|---|---|---|---|---|
| Crowdfund | 1,200,000 - 1,800,000 | 10-15% | Governance proposal | Active once claimed and delegated |
| Early network | 2,400,000 | 20% | Revenue milestones | Revenue-gated |
| Treasury | 7,800,000 - 8,400,000 | 65-70% | Governance-controlled | None |

### Pre-Crowdfund Distribution

Before the crowdfund opens, the following revenue-locked allocations are distributed and published:

**Early Network Allocation (2,400,000 ARM):** Covers launch team, ecosystem contributors, and a reserve for future contributors. All held in a single shared revenue-lock contract with per-beneficiary allocations. Every recipient, wallet address, and amount is published before the crowdfund opens. See REVENUE_LOCK.md for the full contract spec.

**Transparency:**

Crowdfund participants can evaluate the full distribution (ie. who holds what and under what terms) before committing.

### Early Network Allocation

The early network allocation (2,400,000 ARM, 20%) is held in a single shared revenue-lock contract with per-beneficiary allocations. Each recipient has their own entry in the beneficiary list and governs independently. The Knowable Safe appears in the beneficiary list like any other recipient, with a reserve allocation earmarked for future contributors. Future contributor distributions are handled off-chain (token agreements between Knowable and contributors); once ARM is released to the Safe's wallet per the milestone schedule and global transfers are enabled, Knowable distributes via standard transfers. See REVENUE_LOCK.md for the full contract spec.

**Properties:**
- Revenue-locked transferability (same schedule as all early network tokens)
- Voting power unlocks proportionally with revenue milestones
- Recipients do not vote as a bloc

**Constraints:**
- Cannot change the revenue-lock schedule
- Cannot pull from treasury or other allocations
- Knowable Safe's own ARM release follows the same revenue-lock milestone schedule. Future contributor distributions from the Safe are off-chain standard transfers after release and global transfer unlock — they are not on-chain revenue-lock-enforced. See REVENUE_LOCK.md §4.

### Revenue-Gated Unlocks (Early Network)

Early network tokens unlock and gain voting power only via cumulative protocol revenue:

| Cumulative Revenue | Unlocked | Voting Power |
|---|---|---|
| $0 | 0% | 0% |
| $10k | 10% | 10% |
| $50k | 25% | 25% |
| $100k | 40% | 40% |
| $250k | 60% | 60% |
| $500k | 80% | 80% |
| $1M | 100% | 100% |

Governance power follows economic commitment. Until the protocol generates revenue, only people who paid decide.

---

## Word-of-Mouth Whitelist

### Design Philosophy

This is a trusted-network crowdfund, not viral growth. Participation requires invitation from someone closer to the core. Hop-0 and hop-1 each have an enforced ceiling — the maximum fraction of the available pool each can absorb. Hop-2 has no enforced ceiling; instead it has a reserved floor (first claim on 5% of the fund) and an effective ceiling determined by the floor plus any hop-1 leftover. Actual allocation is demand-driven: each hop receives whatever it committed, up to its effective ceiling, and anything unused rolls forward to later hops. The launch team's invite budget closes after week 1; hop-0 and hop-1 participants may invite throughout all three weeks; commitments remain open for the full three weeks.

### Initial Network

The people creating Armada are inviting their network of allies to help form the Armada community. Hop-0 participants, and the initial invitations from the launch team, are the first nodes in a trust network that extends outward through word of mouth.

Hop-0 selection criteria are determined by the launch team based on demonstrated alignment, contribution, and long-term interest in privacy infrastructure.

**Maximum hop-0 count: 160.** The total number of hop-0 participants is capped at 160. This bounds the maximum network size at approximately 1,840 participant slots (160 hop-0 nodes + up to 540 hop-1 nodes + up to 1,140 hop-2 nodes). Arithmetic: hop-1 slots = (160 hop-0 × 3 invites) + 60 launch-team hop-1 = 540; hop-2 slots = (540 hop-1 nodes × 2 invites) + 60 launch-team hop-2 = 1,140. Because the same address may occupy multiple hop levels, the number of distinct individuals may be lower.

**Hop-0 additions.** The launch team may add new hop-0 participants at any point during the first week, up to the 160-participant cap. Participants added later in week 1 naturally have less of the 3-week commitment window remaining — that's the cost of late addition. Once added, a hop-0 participant may issue invitations throughout the full three weeks.

**Launch team hop-1 invite budget.** In addition to hop-0 participants, the launch team holds a predeclared budget of 60 direct hop-1 placements, not tied to any hop-0 slot. This allows the launch team to invite allies with direct relationships to hop-1 without creating phantom unfilled hop-0 slots. The budget is fixed for the duration of the crowdfund.

Launch team hop-1 invitees are full hop-1 participants: same cap ($4,000), same invite rights (up to 2 hop-2 invites each). They appear in the invite graph with the launch team address as inviter. In the `(address, hop)` node model, launch-team-issued invites originate from a designated `(launch_team_address, ROOT)` sentinel node — a fixed address with no hop level and no cap, whose sole role is to issue the predeclared launch team budget. This node is not a participant and makes no commitment.

**Launch team hop-2 invite budget.** The launch team also holds a predeclared budget of 60 direct hop-2 placements. The intended use case is friends, family, and adjacent supporters for whom the $1,000 cap is appropriate. These participants receive no invite rights (consistent with all hop-2 participants). Budget is fixed for the duration of the crowdfund.

**No financial incentive to invite.** Participants receive no allocation benefit from others' commitments. There is no referral bonus, no token reward, and no increase in a participant's own allocation from someone else's commitment. Invitations are an act of community-building, not a financial strategy. This keeps the invite graph honest: people invite those they genuinely want in the community, not those most likely to maximize their own return.

### Hop Structure

| Hop | Description | Ceiling | Floor | Cap | Invites |
|---|---|---|---|---|---|
| 0 | Hop-0 (max 160) | 70% | — | $15,000 | 3 |
| 1 | Hop-0 invites + launch team invitations | 45% | — | $4,000 | 2 |
| 2 | Hop-1 invites + launch team invitations | — ¹ | 5% | $1,000 | 0 |

¹ Hop-2 has no enforced ceiling — only a floor. Its effective ceiling is `hop2_floor + hop1_leftover`, which can reach the full sale size if hop-0 and hop-1 are both empty. The 10% figure shown in some earlier drafts was removed as dead code (`HOP_CEILING_BPS` contains no entry for hop-2).

The launch team holds a predeclared invite budget separate from hop-0: 60 hop-1 invitations and 60 hop-2 invitations. These do not consume hop-0 invite slots. Launch team invitations may only be issued during the first week.

Hop-2 has first claim on 5% of the fund before hop-0 and hop-1 ceilings are applied. This reserved capacity is always available to hop-2, regardless of earlier hop demand, but hop-2 only receives it to the extent hop-2 participants actually commit. Hop-0 and hop-1 ceilings are calculated against the fund net of this reservation. At base fund: $60k reserved for hop-2, hop-0 and hop-1 compete for the remaining $1.14M.

Hop-0 and hop-1 ceilings are overlapping by design — they sum to 115% of the available pool, not 100%. Hop-2 has no enforced ceiling; its effective ceiling is its reserved floor plus any hop-1 leftover, which can range from the floor to the full sale size. No hop is guaranteed to fill its ceiling. Each hop absorbs up to its effective ceiling based on actual demand; anything unused rolls forward. Earlier hops fill first; later hops absorb whatever remains.

### Ceiling Amounts

Hop-2 floor reservation comes off the top. Hop-0 and hop-1 ceilings are applied against the remainder.

**Base fund ($1.2M):**

| Hop | Floor reservation | Available pool | Ceiling (enforced) | Max ceiling (with rollover) |
|---|---|---|---|---|
| 2 | $60,000 | — | No enforced ceiling | $60k floor + full hop-1 leftover |
| 0 | — | $1,140,000 | 70% = $798k | $798k |
| 1 | — | $1,140,000 | 45% = $513k | $1,140k (if hop-0 empty) |

**Expanded fund ($1.8M):**

| Hop | Floor reservation | Available pool | Ceiling (enforced) | Max ceiling (with rollover) |
|---|---|---|---|---|
| 2 | $90,000 | — | No enforced ceiling | $90k floor + full hop-1 leftover |
| 0 | — | $1,710,000 | 70% = $1,197k | $1,197k |
| 1 | — | $1,710,000 | 45% = $769.5k | $1,710k (if hop-0 empty) |

### Invitation Limits

Invitation limits are hop-specific and predeclared:

- Hop-0 → may invite up to 3 addresses to hop-1
- Hop-1 → may invite up to 2 addresses to hop-2
- Hop-2 → may not invite

Invitations are signed on-chain (inviter → invitee, with hop level). The invite graph is defined over `(address, hop)` nodes, not bare addresses. This means:

- The same address may appear at multiple hop levels as a distinct node at each
- An invite edge connects `(inviter_address, inviter_hop)` → `(invitee_address, invitee_hop)`
- A hop-0 participant inviting their own address to hop-1 creates a self-loop edge, visible as such in the graph
- Invite slot consumption is per `(address, hop)` node: a hop-0 node has 3 outgoing invite slots; a hop-1 node has 2. A single address occupying both hop-0 and hop-1 has both slot budgets, consumed independently. **Each invite to a given hop creates a separate participation slot, up to a per-hop stacking cap:** hop-0 = 1 (hop-0 participants are added once), hop-1 = 10, hop-2 = 20. The address's effective cap at that hop equals `participation_slots[(address, hop)] × HOP_CAP[hop]`. Invite rights also scale: each invite to hop-1 grants 2 outgoing hop-2 invite slots. A natural consequence: a hop-0 participant who self-invites their own address to hop-1 three times occupies 3 hop-1 slots (cap: 3 × $4k = $12k) and gains 6 outgoing hop-2 invite slots — giving one address unilateral control over a full $33k subtree, fully legible in the graph. The self-fill analysis ($33k maximum) remains valid because the recursive self-invite tree produces at most 1 hop-0, 3 hop-1, and 6 hop-2 slots — all well within the per-hop stacking caps. For full entity-level capture analysis, see Self-Filling section.
- For allocation, each `(address, hop)` node participates independently — an address at hop-0 and hop-1 receives ARM from both hop buckets, accumulated into a single address balance

This model makes entity-level participation unambiguously legible without wallet correlation. Separate-wallet self-fill is also permitted and visible in graph shape, but same-entity control across wallets is not provable on-chain.

**An address may appear in multiple independent subtrees.** There is no constraint preventing address_a from being a hop-0 participant in their own right while also being invited by an unrelated hop-0 participant to hop-1 or hop-2. Each `(address, hop)` node participates in allocation independently, so address_a accumulates ARM from every position it holds across all subtrees. All such participation is visible in the graph — every edge is public — so participants can observe multi-subtree presence directly. This is a deliberate choice: we cannot prevent it, and allowing the same address makes concentration legible rather than hidden.

### Invite Mechanism

Invitations can be issued through two paths. Both produce the same on-chain result — an `Invited` event and a new edge in the invite graph — but they differ in who initiates the transaction and when the invitee's address is known.

#### Path A: Invite Link (signature-based, primary)

The inviter creates a shareable link without knowing the recipient's address. The invitee opens the link, connects their wallet, and joins the network by committing USDC — all in a single atomic transaction.

**How it works:**

1. The inviter signs an EIP-712 typed data message authorizing one invite slot. No gas, no on-chain transaction. The message contains:
   - `inviter`: the inviter's address
   - `fromHop`: the inviter's hop level (determines the invitee's hop as `fromHop + 1`)
   - `nonce`: per-inviter unique identifier (any `uint256 > 0`; nonce 0 is reserved for direct invites; each nonce can be consumed or revoked once; UI generates sequential nonces starting from 1)
   - `deadline`: block timestamp after which the signature is invalid (default: 5 days from creation)

2. The signed message is encoded into a URL and shared privately (DM, email, Signal, etc.).

3. The invitee opens the link, connects their wallet, enters a commitment amount, and submits a single transaction: `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)`.

4. The contract verifies the signature, checks the nonce and deadline, records the invite edge, records the commitment, and emits both `Invited` and `Committed` events atomically.

**Properties:**
- **Bearer credential.** The link can be used by anyone who has it. The inviter does not choose the recipient — the first person to redeem the link becomes the invitee. Share links privately. Because the signature does not bind to the invitee's address, a pending `commitWithInvite()` transaction is front-runnable: a mempool observer can extract the signature and submit a competing transaction. The committer app mitigates this by recommending private transaction submission (e.g., Flashbots Protect on Ethereum mainnet), which avoids public broadcast before inclusion. This is a UI-layer mitigation, not a protocol guarantee. See CROWDFUND_COMMITTER.md for implementation details.
- **No slot reservation.** Signing a link does not reserve an invite slot. Slots are checked at redemption time. An inviter may sign more links than they have slots; only the first N redeemed (where N = available slots) will succeed.
- **Invite and commitment are atomic.** The invitee appears in the graph only when they commit with funds. There are no invited-but-uncommitted phantom nodes from the link path.
- **5-day default expiry.** The `deadline` is baked into the signed message. Expired links fail at redemption. Generating a replacement link is free (another off-chain signature).
- **Revocable.** The inviter may call `revokeInviteNonce(nonce)` to permanently invalidate a link before it is redeemed. This is an on-chain transaction (costs gas) and serves as a kill-switch for leaked links.

**Signature verification:** The contract uses OpenZeppelin's `SignatureChecker.isValidSignatureNow()`, which supports both EOA wallets (via `ecrecover`) and smart contract wallets (via EIP-1271 `isValidSignature`). This ensures multisig and smart wallet users can create invite links.

**EIP-712 domain (all four fields validated by the contract):**

```
domain: {
  name: "ArmadaCrowdfund",
  version: "1",
  chainId: <deployment chain>,
  verifyingContract: <crowdfund contract address>
}
```

All four domain fields must be validated to prevent cross-chain and cross-contract signature replay.

#### Path B: Direct Invite (on-chain, fallback)

The inviter enters the invitee's address and calls `invite(invitee, fromHop)` directly, where `fromHop` is the inviter's hop level and the invitee joins at `fromHop + 1`. The invite is recorded on-chain immediately. The invitee appears in the graph with $0 committed and can commit separately at any time before the deadline.

**Properties:**
- **Address-targeted.** The inviter must know the invitee's address at invite time.
- **Inviter pays gas.** The invitee pays nothing until they choose to commit.
- **Graph presence before commitment.** Unlike the link path, the invitee appears in the graph immediately — even if they never commit. This is accepted because the inviter is making a deliberate, addressed placement.

Both paths produce the same graph edge — `(inviter, fromHop) → (invitee, fromHop + 1)` — and the same `Invited` event. The difference is operational: links are for "share a link with someone you want in the community"; direct invites are for "I know this person's address and want to place them now."

#### Duplicate Invites

Multiple inviters may invite the same address to the same hop, up to the per-hop stacking cap (`maxInvitesReceived`: hop-0 = 1, hop-1 = 10, hop-2 = 20). Each invite creates a new participation slot for that address at that hop. The invitee's effective cap at the hop increases by `HOP_CAP[hop]` per invite received — this is the same `participation_slots[(address, hop)] × HOP_CAP[hop]` rule that applies to self-invites. All edges are recorded and visible in the graph. An invite slot is consumed for each inviter regardless.

Note: `invitedBy` records only the first inviter for each `(address, hop)` node. When subsequent inviters stack additional invites to the same node, `invitesReceived` increments but `invitedBy` does not change. The full multi-inviter history is recoverable from `Invited` events.

The same inviter may also invite the same address to the same hop more than once (e.g., via two separate links). Each successful redemption creates a new slot. This is permitted for consistency ("allow everything, make it visible"), and the inviter's slot budget limits how many such invites they can issue.

#### Invite Revocation

Invites issued via the direct path (`invite()`) are irrevocable — once the on-chain transaction confirms, the invitee has a permanent position.

Invite links (Path A) can be revoked before redemption by calling `revokeInviteNonce(nonce)`. This permanently invalidates the nonce. The revoked link will fail if anyone attempts to redeem it. Revocation does not free the invite slot — the slot is not consumed until a link is successfully redeemed.

### Self-Filling and Max Single-Entity Capture

A participant may commit at multiple hop levels using a single address, and receives ARM allocation from each hop they participate in — subject to that hop's per-slot cap and pro-rata rules. This is the preferred model for transparency: a hop-0 participant using the same address across all hops creates unambiguously legible self-loop edges in the invite graph, and receives their full multi-hop allocation without any penalty.

An address may appear at a given hop multiple times, up to the per-hop stacking cap (hop-0 = 1, hop-1 = 10, hop-2 = 20). Each invite to a hop creates a separate participation slot, and the effective cap equals `participation_slots[(address, hop)] × HOP_CAP[hop]`. A hop-0 participant using all 3 of its hop-1 invite slots on itself gains 3 hop-1 slots (cap: 3 × $4k = $12k), and each of those slots grants 2 hop-2 invites — 6 hop-2 slots total (cap: 6 × $1k = $6k).

Maximum self-fill for a hop-0 participant via full recursive self-invitation with one address:

| Hop | Per-slot cap | Slots (self-invite) | Max USDC (single address) |
|-----|-------------|---------------------|--------------------------|
| Hop-0 | $15,000 | 1 | $15,000 |
| Hop-1 | $4,000 | 3 (from hop-0 invites) | $12,000 |
| Hop-2 | $1,000 | 6 (from hop-1 invites) | $6,000 |
| **Total** | | | **$33,000** |

An address may also receive invites from other participants (e.g., another hop-0 participant inviting the same address to hop-1), which adds further slots beyond the self-invite tree, up to the per-hop stacking cap. The per-hop cap for any address is `min(participation_slots[(address, hop)], maxInvitesReceived[hop]) × HOP_CAP[hop]`. An address invited by multiple independent hop-0 participants accumulates across all subtrees; all such participation is visible in the graph.

Participating across hops using separate wallets is also permitted. Graph edges are visible, but same-entity control across separate wallets cannot be proven on-chain.

A hop-0 participant committing at all three hops via full recursive self-invitation gets ARM allocation at all three — up to $15k from hop-0, $12k from hop-1 (3 slots × $4k), and $6k from hop-2 (6 slots × $1k) — for a maximum of $33k, subject to pro-rata scaling if any hop is oversubscribed. $33,000 out of a $1.2M base fund is 2.75%.

The actual deterrents to governance concentration remain:

1. **Real capital required at every slot.** $33k via recursive self-invite is the self-fill maximum. Oversubscription scales everyone back pro-rata.
2. **Cap differential.** Hop-0 gets $15k per slot, hop-1 gets $4k per slot, hop-2 gets $1k per slot. The incremental benefit of filling lower hops is real but bounded by the invite tree structure.
3. **Graph visibility.** The full invite graph is public in real time. Multi-hop participation by a single address — including recursive self-invitation — is fully legible.
4. **Governance concentration has low ROI pre-revenue.** Accumulating votes in a protocol with a testnet product is not obviously valuable.

Residual risk — a hop-0 participant concentrating votes at scale — is primarily mitigated by trusted-network hop-0 selection. The mechanism does not make it impossible; it makes it expensive and bounded. Same-address multi-hop is fully visible on-chain; multi-wallet self-fill is visible in graph shape but same-entity control is not provable.

---

## Crowdfund Mechanics

### Timeline

| Phase | Duration |
|---|---|
| Launch team invite window | Days 1–7 (first week only) |
| Hop-0 invite window | Days 1–21 (full 3 weeks) |
| Hop-1 invite window | Days 1–21 (full 3 weeks) |
| Commitment window | Days 1–21 (full 3 weeks) |

The launch team's invite budget (hop-0 additions, hop-1, hop-2 placements) may only be issued during the first week. Hop-0 and hop-1 participants may issue invitations throughout the full three weeks — right up to the commitment deadline. This limits the launch team's ability to issue new invitations with live oversubscription data visible (they can still do so during days 1–7 but not after), while giving hop-0 and hop-1 participants maximum flexibility to propagate the network throughout the window. Note: a launch team hop-1 invitee issued on day 7 has the full remaining 14 days to issue their own hop-2 invitations — the launch team's invite window closing does not affect hop-1 invite rights.

### Commitment

- **Currency:** USDC
- **Method:** Commit to escrow contract
- **Multi-hop commits from the same address are permitted.** An address may commit at multiple hop levels and receives ARM allocation from each hop it participates in. This makes entity-level participation unambiguously legible on-chain: a hop-0 participant who also fills hop-1 and hop-2 slots with the same address is visibly doing so, and receives the ARM from all three pools.
- **Multiple commitments:** A participant may commit multiple times to any hop. Commitments from the same address at the same hop are aggregated into a single running balance, capped at `participation_slots[(address, hop)] × HOP_CAP[hop]` for allocation purposes (each invite to a hop creates a separate participation slot).
- **Visibility:** Address, amount, hop, and invite edges are all public in real time
- **No withdrawals:** Commitments are final once submitted. Participants cannot withdraw USDC before the deadline. The commitment window is a maximum of 3 weeks; participants should only commit amounts they are prepared to lock for that period.

Real-time aggregate statistics show current commitment levels per hop throughout the window, allowing participants to observe oversubscription before committing. **Per-hop totals are the canonical display** — each hop shows the effective demand committed to that hop, regardless of whether any addresses also participate at other hops. An address committed at hop-0 and hop-1 contributes to both hop totals independently. This means the sum of all displayed per-hop totals may exceed the sale size, which is expected and correct — it reflects genuine multi-hop demand that will be allocated and scaled per hop.

### ARM Pre-Load Requirement

**1,800,000 ARM (MAX_SALE) must be present in the crowdfund contract before the commitment window opens.** The ARM token constructor mints 1,800,000 ARM directly to the crowdfund contract address (see ARM_TOKEN.md §3). The crowdfund contract enforces this with a deployment-time flag — the commitment function reverts until ARM is loaded and verified. This ensures participant claim records written at finalization are always backed by sufficient ARM.

Deployment sequence:
1. Deploy `ArmadaCrowdfund` with treasury address, ARM address, timing parameters (ARM token uses CREATE2 precomputed address — see REVENUE_LOCK.md §3)
2. Deploy ARM token — constructor mints 1,800,000 ARM directly to the crowdfund contract
3. Call `loadArm()` to verify balance and set the flag

`loadArm()` may be called before or at the configured open timestamp. If called in advance, the contract is armed but `commit()` reverts until the open timestamp is reached. `addSeed()` and `launchTeamInvite()` are similarly gated to the week-1 window (which begins at the open timestamp) and must not be called before the window is active.

4. Commitment window opens at the configured open timestamp

### Finalization

After the commitment window closes, finalization is permissionless — anyone may call `finalize()` once the commitment deadline has passed. There is no minimum raise precondition on `finalize()` itself — the contract always runs the allocation math and determines the outcome:

- If `totalAllocatedUsdc >= MINIMUM_RAISE`: success path (ARM allocated, proceeds to treasury)
- If `totalAllocatedUsdc < MINIMUM_RAISE`: sets `refundMode = true` (full refunds, no ARM allocated)

This means every post-deadline outcome flows through `finalize()`. There is no separate "deadline fallback" path where refunds become available without finalization. A participant may withdraw their full deposited USDC via `claimRefund()` if and only if **any** of these conditions hold:

1. `refundMode == true` — set by `finalize()` when `totalAllocatedUsdc < MINIMUM_RAISE`
2. `cancelled == true` — Security Council invoked `cancel()`

No privileged action or separate function is required — the eligibility check is built into `claimRefund()` itself. Someone must call `finalize()` post-deadline for refunds to activate in the sub-minimum case, but the call is permissionless and low-cost.

When `finalize()` is called:

> `finalize()` writes only aggregate state — zero per-participant storage writes. Individual allocations are computed on-the-fly at `claim()` time using aggregate parameters stored by `finalize()` plus the participant's own commitment records (already on-chain from `commit()`). This is the lazy settlement architecture.

1. Crowdfund size is determined (base or expanded, based on total capped demand)
2. **Per-hop effective ceilings are calculated via the waterfall pass:** hop-2 floor reserved first, hop-0 ceiling applied against the available pool, hop-0 leftover increases hop-1's effective ceiling, hop-1 leftover increases hop-2's effective ceiling. The stored `ceilings[hop]` values are the **final effective ceilings after the waterfall** — not the raw BPS ceilings from the hop table. These are the numbers `computeAllocation()` uses directly.
3. **Per-hop aggregate demand is computed:** `finalize()` iterates all participants once to compute `hopDemand[hop]` — the sum of `effectiveUsdc(p, hop)` for all participants at that hop, where `effectiveUsdc(p, hop) = min(committed[p][hop], slotCount[p][hop] * HOP_CAP[hop])`. **Multiple slots per hop per address is a hard requirement** — the entire cap model, self-fill analysis, and `computeAllocation()` logic depend on `slotCount[p][hop]` being a counter that increments with each invite received. If the contract models caps as a single boolean "has access to this hop" rather than a slot count, this spec is incorrect and the allocation math must be redesigned.
4. **Aggregate allocation is computed:** `totalAllocatedUsdc = sum(min(hopDemand[hop], ceilings[hop]))` across all hops. `totalAllocatedArm = totalAllocatedUsdc * ARM_PER_USDC_RATE`.
5. **Post-allocation minimum raise check:** if `totalAllocatedUsdc < MINIMUM_RAISE ($1,000,000 USDC)`, the contract sets **both `finalized = true` and `refundMode = true`** and stops — no treasury transfer, no aggregate recording beyond the flags. Setting `finalized = true` permanently disables further calls to `finalize()` and `cancel()`. **In this branch, every participant may call `claimRefund()` to withdraw their full deposited USDC** — not a pro-rata refund, but the complete raw amount they deposited. **`claim()` reverts when `refundMode == true`.** This branch handles both cases: (a) `capped_demand` was below $1M (obvious failure — allocation math produces near-zero totals), and (b) `capped_demand` was above $1M but post-waterfall `totalAllocatedUsdc` fell below $1M (occurs at base size when hop-0 is oversubscribed and combined later-hop demand doesn't close the gap). Neither case can occur after expansion, where hop-0's ceiling ($1,197k) already exceeds the minimum raise. This must not revert the transaction — a revert would leave the contract permanently stuck with no path to refunds or ARM recovery.
6. **Aggregate state is written:** `finalized = true`, `finalizationTimestamp`, `saleSize`, `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`, `totalArmTransferred = 0` (counter incremented by `claim()` when ARM is actually sent)
7. **Net USDC proceeds transfer immediately to treasury** — `netProceeds = totalAllocatedUsdc` (USDC domain — computed directly from accepted USDC, not from `totalAllocatedArm * PRICE` which can diverge by rounding dust), transferred in the same transaction

No per-participant allocation or refund amounts are written to storage. The only per-participant storage write in the entire settlement flow is `claimed[msg.sender] = true` inside `claim()`.

### Canonical allocation computation

`computeAllocation(address)` is a **required public view function** — the UI and observer both need the exact same logic path as `claim()`, minus side effects. Frontend/contract drift is prevented by having a single canonical computation.

```
computeAllocation(participant) → (uint256 armAmount, uint256 refundUsdc):

  totalAcceptedUsdc = 0
  totalCommittedUsdc = 0

  for each hop where participant holds a slot:
    committedUsdc = committed[participant][hop]
    effectiveUsdc = min(committedUsdc, slotCount[participant][hop] * HOP_CAP[hop])
    totalCommittedUsdc += committedUsdc

    if hopDemand[hop] <= ceilings[hop]:
      acceptedUsdc = effectiveUsdc
    else:
      acceptedUsdc = ceilings[hop] * effectiveUsdc / hopDemand[hop]  // floor division

    totalAcceptedUsdc += acceptedUsdc

  refundUsdc = totalCommittedUsdc - totalAcceptedUsdc
  armAmount = totalAcceptedUsdc * ARM_PER_USDC_RATE  // floor

  return (armAmount, refundUsdc)
```

Three explicit domains — no ambiguity between USDC and ARM:
- **committedUsdc** — what the participant deposited (raw, may exceed cap)
- **effectiveUsdc** — committedUsdc capped to slot allowance
- **acceptedUsdc** — what counts toward their allocation (USDC domain, after pro-rata if oversubscribed)
- **refundUsdc** — what they get back: `committedUsdc - acceptedUsdc` (USDC domain)
- **armAmount** — derived from `acceptedUsdc` at the sale conversion rate (ARM domain)

`computeAllocation()` always returns the **theoretical entitlement** regardless of timing or claim status. It is **pure deterministic math over finalized state**: no claim-order dependence, no mutable per-user inputs beyond the participant's own committed balances and slot counts, no dependence on current contract balances or other participants' claim status. This property makes auditing straightforward and eliminates interpretation ambiguity.

**Implementer note:** The `ceilings[hop]` and `hopDemand[hop]` values used in `computeAllocation()` are stored by `finalize()` after the waterfall pass (see appendix pseudocode steps 3-6). They are the effective post-waterfall ceilings, not the raw BPS values from the hop table. Do not recompute the waterfall inside the view function.

### Rounding

- **`acceptedUsdc`**: floor division at participant level, per hop, then summed. A hop ceiling may not be fully allocated (floor of each participant's share leaves residual capacity). This is intentional — the dust is not distributed.
- **`refundUsdc = committedUsdc - acceptedUsdc`**: because `acceptedUsdc` floors, refund effectively rounds up. Participant is never under-refunded.
- **`armAmount = totalAcceptedUsdc * ARM_PER_USDC_RATE`**: floor. Participant never over-receives ARM.
- **Dust sink:** treasury. Residual ARM (from rounding across all participants) becomes part of the unsold/sweepable pool.

### Conservation invariants

**Settlement-completion accounting identities** (hold once all participants have claimed — not standing invariants at arbitrary intermediate times):

```
sum(armTransferred[p] for all claimed p) + sweepableArm == 1,800,000 ARM
  where sweepableArm = 1,800,000 - totalArmTransferred

sum(refundUsdc[p] for all claimed p) + netProceeds == totalCommitted
```

**Standing invariants** (hold at all times after finalization):

```
totalArmTransferred <= totalAllocatedArm <= 1,800,000 ARM
USDC balance in contract == totalCommitted - netProceeds - sum(refunds paid out)
```

### Order-independence

All participant entitlements are fixed at `finalize()` time. Claims may occur in any order. No claim changes any other participant's entitlement. `computeAllocation()` is a pure function of the caller's commitments plus the aggregate parameters written by `finalize()`.

### Claim mechanics

`claim(delegate)` computes the caller's allocation on-the-fly, transfers ARM and/or refund USDC, and records delegation:

- **ARM portion: subject to 3-year expiry.** ARM is transferred only when `block.timestamp <= finalizationTimestamp + 3 years`. `delegateOnBehalf(msg.sender, delegate)` only runs when ARM is actually transferred.
- **Refund portion: always payable, no expiry.** The USDC refund component of a success-path claim has no deadline.
- **`claimed[msg.sender] = true`** is set permanently regardless of what was transferred. A participant who claims after the 3-year deadline receives any refundable USDC but **permanently forfeits ARM entitlement** — this is an economically meaningful consequence, not just implementation behavior.
- **`totalArmTransferred`** increments only when ARM is actually sent (not when entitlement is computed). This counter is distinct from `totalAllocatedArm` (theoretical aggregate): `totalAllocatedArm` is the sale allocation used by the observer and Finalized event; `totalArmTransferred` tracks actual delivery and is used by `withdrawUnallocatedArm()` to compute sweepable ARM.
- **`nonReentrant`** modifier required — `claim()` makes external token transfers and a `delegateOnBehalf` call.
- **Events:** `Allocated` emits `armTransferred` (actual ARM sent in this call, not theoretical entitlement), `refundUsdc` (actual USDC refund sent), and `delegate` (delegation target, or `address(0)` if no ARM transferred). `AllocatedHop` emits per-hop `acceptedUsdc` (theoretical, USDC domain — not affected by ARM expiry, since expiry affects transfer timing, not sale participation). Settlement invariant: `sum(AllocatedHop.acceptedUsdc) * ARM_PER_USDC_RATE >= Allocated.armTransferred` (equality holds within 3-year window; after expiry, `armTransferred` is 0 while per-hop acceptance is unchanged).

`claimRefund()` remains exclusively for refundMode / cancel / pre-finalization paths. Success-path refunds go through `claim()`. **There is no refund-only path for the success case** — a participant who wants their USDC refund must call `claim()`, which also handles the ARM portion (transferring it within the 3-year window, or forfeiting it after expiry). This is a deliberate tradeoff: bundling refunds into `claim()` avoids a separate per-participant refund storage write in `finalize()` and keeps the lazy settlement architecture clean, at the cost of requiring every participant — even those with small oversubscription refunds — to engage the full claim path.

Refunds are pull-based — participants call `claimRefund()` once eligible (see the three-condition eligibility rule above). This avoids gas grief from iterating over all participants in a single transaction. Refunds via `claimRefund()` do not expire.

ARM claim remains a separate participant-initiated step (one transaction per claimant). USDC net proceeds flow to treasury at finalization regardless of whether participants have claimed their ARM or refunds.

Crowdfund tokens are not revenue-gated, but voting power only becomes active once ARM is claimed and delegated. Allocated-but-unclaimed ARM is vote-inert regardless of any governance unlock proposal that passes.

**Governance quiet period: 7 days after finalization.** No governance proposals may be submitted until day 8 post-finalization. This gives the community time to claim, delegate, and orient before governance begins. Any emergency during this window is handled by the Security Council (pause, veto, coordinated response) — it does not require a governance vote. The quiet period is a one-time bootstrapping measure — it is a constructor parameter that applies once and has no effect after expiry.

**Early-claim governance risk.** Voting power uses Compound-style point-in-time checkpointing — there is no time-weighted average. An address that claims and delegates immediately after finalization has its full balance active with no averaging period. Quorum at proposal creation is measured against circulating ARM at that block — which, immediately after finalization, is essentially only the ARM that has been claimed, since unclaimed ARM in the crowdfund contract and unreleased ARM in the revenue-lock contract are excluded from the denominator (see GOVERNANCE.md §Quorum denominator). If very few participants have claimed, a single early claimer with 5,000+ ARM could meet proposal threshold and create a vote where quorum is a fraction of the full crowdfund supply. The 48-hour proposal delay and 7-day quiet period are the only buffers. Participants are strongly encouraged to claim and delegate promptly after finalization. **This is an accepted design choice, not an unsolved problem** — additional mechanical buffers (e.g., time-weighted voting, minimum claimed supply before governance activates) would add complexity to the ARM token or governor that contradicts the "~50 lines of custom code on OZ primitives" constraint. The Security Council provides emergency response during this window if needed.

**Claim deadline: 3 years from finalization.** The deadline is fixed and cannot be extended — it is a predeclared term of participation, not a governance parameter. Exact boundary: `claim()` is permitted when `block.timestamp <= finalizationTimestamp + 3 years`; `withdrawUnallocatedArm()` may sweep unclaimed ARM only when `block.timestamp > finalizationTimestamp + 3 years`.

**`withdrawUnallocatedArm()` eligibility — three windows with time-conditional sweep amounts:**
- **Immediately post-finalization, before 3-year deadline (`finalized == true && block.timestamp <= finalizationTimestamp + 3 years`):** sweeps `1,800,000 - totalAllocatedArm` — all ARM not allocated to any participant, including (in a base crowdfund) the 600,000 ARM preloaded for potential expansion that was never needed. Does not touch allocated-but-unclaimed ARM — participants may still claim.
- **After the 3-year claim deadline (`finalized == true && block.timestamp > finalizationTimestamp + 3 years`):** sweeps `1,800,000 - totalArmTransferred` — all ARM not actually delivered to participants. This includes unsold ARM, allocated-but-never-claimed ARM, and ARM forfeited by participants who claimed after expiry (received refund only). `totalArmTransferred` is the running counter incremented by `claim()` when ARM is actually sent. This is a **semantic expansion** from the pre-3yr sweep — the function now sweeps unsold + unclaimed + forfeited. The time check determines which formula applies.
- **After `cancel()`:** sweeps all preloaded ARM (1,800,000) — the crowdfund is in cancelled state, not finalized, so the function must check `cancelled` as an additional eligibility condition alongside `finalized`.

All three send to the immutable treasury address. The function may be called at any time; it sweeps whatever is currently eligible under the above rules. **After the 3-year deadline, this function also sweeps allocated-but-undelivered ARM — the name "unallocated" understates the post-expiry scope.**

**Commitment deadline is contract-enforced.** The contract reverts any commitment transaction submitted after the deadline timestamp. This is a hard contract-level guard, not a UI convention.

Post-finalization, all privileged functions are permanently inactive. `withdrawUnallocatedArm()` is permissionless — anyone may call it, and ARM transfers to the immutable treasury address set at deployment. No privileged role survives finalization.

### Allocation

The allocation algorithm proceeds in four sequential steps, each with a separately bounded budget:

1. **Hop-2 floor reserved first.** 5% of `sale_size` is set aside for hop-2 before hop-0 or hop-1 are allocated. Hop-0 and hop-1 compete only for the remaining `available` pool.

2. **Hop-0 allocated from `available`.** Demand is served up to `hop0_ceiling`. Any unused hop-0 capacity increases hop-1's effective ceiling.

3. **Hop-1 allocated from remaining available.** Hop-1's effective ceiling = `min(hop1_ceiling + hop0_leftover, remaining_available)`. Bounded by what remains after hop-0.

4. **Hop-2 allocated from floor + hop-1 leftover.** Hop-2's effective ceiling = `hop2_floor + hop1_leftover`. The floor is always available regardless of earlier hop demand. Any capacity hop-2 doesn't absorb becomes unsold ARM, recoverable via `withdrawUnallocatedArm()`.

Oversubscription at any hop is resolved pro-rata within that hop's effective ceiling, bounded by per-address per-hop caps (where the cap equals `participation_slots[(address, hop)] × HOP_CAP[hop]`). An address committed at multiple hops receives ARM allocation from each hop independently. See appendix for full pseudocode.

`capped_demand` — the sum of all aggregated per-address per-hop balances after caps — is the canonical demand variable used for the minimum raise check, the expansion trigger, and per-hop statistics. An address committed at multiple hops contributes to `capped_demand` at each hop independently.

### Rollover

Rollover is integrated into the allocation steps rather than a separate pass:

- Hop-0 leftover increases hop-1's effective ceiling (bounded by what remains after hop-0)
- Hop-1 leftover increases hop-2's effective ceiling (stacks on top of the guaranteed floor)
- Hop-2 leftover becomes unsold ARM, recoverable via `withdrawUnallocatedArm()`

Leftover never rolls back to earlier hops.

### Elastic Expansion

The crowdfund expands if `capped_demand` reaches or exceeds the expansion trigger.

```python
if capped_demand >= EXPANSION_TRIGGER:  # $1.5M USDC capped demand
    sale_size = MAX_SALE  # 1,800,000 ARM ($1.8M, 15% of supply)
else:
    sale_size = BASE_SALE  # 1,200,000 ARM ($1.2M, 10% of supply)
```

Expansion is binary: either base ($1.2M) or max ($1.8M). If capped demand clears $1.5M, supply expands to maximum. Oversubscribed hops are allocated pro-rata up to their effective ceiling; the difference between a participant's commitment and their allocation is refunded.

### Refunds

Refunds arise from two sources: deposits exceeding the per-slot cap (`committedUsdc - effectiveUsdc`), and pro-rata scaling when a hop is oversubscribed (`effectiveUsdc - acceptedUsdc`). The canonical computation is USDC-domain-first:

```
refundUsdc = committedUsdc - acceptedUsdc
```

where `acceptedUsdc` is the participant's share of the hop ceiling (full effective balance if not oversubscribed, pro-rata share if oversubscribed). See §Canonical allocation computation for the full `computeAllocation()` logic.

**Success-path refunds** are paid inside `claim()` — there is no separate refund-only path for the success case. **RefundMode / cancel / pre-finalization refunds** are paid via `claimRefund()` and return the participant's full raw deposited USDC. Refunds via `claimRefund()` do not expire. Success-path refunds via `claim()` also do not expire (the ARM portion expires after 3 years, but the USDC refund portion is always payable).

---

## Emergency Cancel

The crowdfund contract includes an emergency cancel mechanism for catastrophic pre-finalization scenarios: a critical contract bug, a regulatory injunction, or another event that would make proceeding harmful to participants.

**Authority:** Security Council (3-of-5 multisig — see GOVERNANCE.md)

**Process:**
1. Security Council invokes `cancel()` — takes effect immediately
2. Contract enters refund-only mode: all committed USDC becomes withdrawable by participants via `claimRefund()`. No further privileged action required — participants pull their own refunds.

**`cancel()` sets a permanent cancelled state.** After `cancel()` is invoked: `finalize()` permanently reverts (the cancelled flag is checked at entry); `commit()` permanently reverts — no new USDC may be deposited; participants may call `claimRefund()` to withdraw their full deposited USDC; and all preloaded ARM (1,800,000) becomes immediately sweepable to the immutable treasury address via `withdrawUnallocatedArm()`. The cancelled state is irreversible.

**Constraints:**
- Only callable before `finalize()` has been executed
- Once finalized, `cancel()` permanently reverts — no post-finalization admin leverage
- Refund mode is automatic and unconditional; the Security Council has no discretion over individual refunds

**Rationale:** Cancel takes effect immediately because a genuine emergency (active exploit, regulatory injunction) requires speed — a delay serves the attacker, not participants. Abuse protection comes from Security Council composition (not purely team-controlled), automatic unconditional refunds (no discretion over destination), and the pre-finalization-only restriction. The on-chain transaction is public the moment it is submitted.

---

## Governance

Crowdfund tokens are not revenue-gated. Voting power becomes active once ARM is claimed and delegated — unclaimed ARM is vote-inert. Early network tokens gain voting power proportional to revenue-milestone unlocks — at $0 protocol revenue, only crowdfund participants who have claimed and delegated vote.

ARM must be delegated to vote. Delegation is designated at claim time as a mandatory parameter. The Security Council can cancel the crowdfund pre-finalization in an emergency — see §Emergency Cancel.

Standard proposals take approximately 11 days (48h delay + 7d vote + 48h execution). High-impact proposals (fee changes, treasury >5%, governance parameters, steward elections) take approximately 18 days (48h + 14d + 7d). Bond: 1,000 ARM (activates after global transfer unlock — before that, governance operates on proposal threshold only). Proposal threshold: 5,000 ARM.

Crowdfund tokens become transferable via governance proposal. There are no predeclared conditions — holders decide when.

Early network tokens cannot be unlocked by governance. They unlock only via revenue milestones.

Treasury tokens (65–70%) are controlled by governance but do not vote.

See GOVERNANCE.md for full specification: voting mechanics, delegation, quorum, proposal lifecycle, Treasury Steward, Security Council, and wind-down.

---

## Invite Graph Visibility

The full invite graph is public throughout the crowdfund — inviter, invitee, and hop level are visible from the moment an invite is issued. There is no post-finalization reveal step.

Participants are joining a trust network, and that network's shape should be legible to everyone in it. Full visibility during the crowdfund also reinforces the governance bootstrapping framing: you can see who you're building the network with before committing.

---

## Wind-Down

### Automatic wind-down

The protocol triggers an automatic wind-down if the revenue threshold is not reached by the deadline. Both parameters are governable with the following defaults:

| Parameter | Default | Governable |
|---|---|---|
| Revenue threshold | $10,000 cumulative | Yes (standard proposal) |
| Deadline | December 31, 2026 | Yes (standard proposal) |

The intent is to give the protocol approximately 6 months after mainnet launch to demonstrate traction. December 31, 2026 is the concrete implementation default and is calibrated to that intent based on the current launch timeline. If launch slips materially, governance should update the deadline before it becomes binding.

If cumulative protocol revenue does not reach the threshold by the deadline, wind-down initiates automatically — no governance vote required. Governance may adjust either parameter before the deadline, or vote to wind down early at any time.

### Wind-down sequence

1. Wind-down triggers (automatic or governance vote). `triggerWindDown()` is permissionless — anyone can call it when conditions are met.
2. ARM transfers are automatically enabled (`setTransferable(true)` called as part of the wind-down transaction)
3. Shielded pool enters withdraw-only mode (immediate — `shield()` and shielded `transfer()` disabled; `unshield()` always available indefinitely with no deadline)
4. Governance ends permanently — no new proposals, no steward proposals, no parameter changes
5. Non-ARM treasury assets are swept to the redemption contract via permissionless `sweepToken(address)` calls (one per token; `sweepToken(ARM)` reverts — treasury ARM stays locked permanently)
6. ARM holders deposit ARM into the redemption contract and receive their pro-rata share of non-ARM treasury assets. No snapshot, no deadline — deposit whenever you want. See GOVERNANCE.md §Wind-Down for the full redemption mechanism.
7. Early network tokens have no treasury claim unless released via revenue milestones before wind-down. Unreleased ARM stays in the revenue-lock contract permanently.

**Unclaimed ARM after wind-down.** Participants may claim their ARM at any time after wind-down (subject to the 3-year deadline). Once claimed, they can deposit it into the redemption contract to receive their treasury share. The 3-year ARM claim deadline continues to apply. Unclaimed ARM in the crowdfund contract is excluded from the redemption denominator, so it does not dilute redeemers.

Those who paid have priority over those who received tokens at zero cost basis. Locked tokens only unlock if protocol earns revenue — if the protocol failed before earning revenue, those tokens stay locked and have no claim on remaining assets.

---

## Risk Acknowledgments

- **Hop-0 selection quality is the critical dependency.** The allocation mechanism is algorithmic, but the network's governance quality depends entirely on the launch team's hop-0 selection. Trusted-network hop-0 selection is the primary defence against governance concentration and Sybil attacks — the contract mechanism does not substitute for it. Maximum single-entity capture from one subtree is $33k (2.75% of base fund); an address invited by multiple hop-0 participants accumulates beyond this. See Self-Filling section.
- **At base size, hop-0 alone cannot meet the minimum raise.** Hop-0's ceiling ($798k at base fund) is below the minimum raise ($1M). However, the same addresses filling hop-0 can also commit at hop-1 and hop-2 — those contributions count independently. For example, 67 hop-0 participants each committing $15k at hop-0 and $4k at hop-1 produces $1.273M capped_demand (base sale) and ~$1.066M net_proceeds — sufficient to finalize. After expansion (capped_demand ≥ $1.5M), hop-0's ceiling rises to $1,197k and hop-0 alone can succeed.
- **Early governance proposals may pass on thin quorum.** Voting power activates immediately upon claim and delegation with no averaging period. The first proposals after the 7-day quiet period may be created when only a small fraction of participants have claimed. Participants are strongly encouraged to claim and delegate promptly after finalization.
- **Governance capture is possible.** Whitelist is the mitigation, not a guarantee.
- **Propagation may fail.** Unused supply flows to treasury.
- **This is a trusted-network crowdfund.** Not designed for viral distribution.
- **Tokens are non-transferable at launch by design.** Transferability prioritizes governance participation during the formative phase. Token transfers can be unlocked by governance proposal.
- **Automatic wind-down is a real risk.** If the protocol does not reach $10k revenue by December 31, 2026, wind-down initiates automatically.
- **Multi-slot-per-hop is the core implementation dependency.** The entire allocation math — cap scaling, self-fill analysis, `hopDemand`, `computeAllocation()` — depends on the contract modeling `slotCount[address][hop]` as a counter that increments with each invite received. If the contract models hop access as a boolean rather than a counter, the spec's math is wrong. This must be confirmed in code before the crowdfund math is treated as settled.
- **Wind-down / ARM token integration is an audit hotspot.** Wind-down assumes it can call `setTransferable(true)`, sweep non-ARM assets, exclude four hardcoded addresses from the redemption denominator, and end governance permanently. These hooks between the wind-down contract, ARM token, governor, and redemption contract are load-bearing — if any are slightly off, the wind-down integration story weakens. Priority audit target.

---

## Summary of Design Decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Treasury voting | Treasury does not vote | Avoids control ambiguity |
| Early network voting | Revenue-gated | Only people who paid decide until protocol proves itself |
| Steward voting eligibility | Voting-eligible ARM only | Treasury decisions by economic stakeholders |
| Invite graph | Fully public throughout the crowdfund | No post-finalization reveal step. Participants are joining a trust network — its shape should be legible from the start. Simplifies implementation; reinforces governance bootstrapping framing over token allocation framing |
| Enactment delay | 48 hours standard; 7 days extended | Short delay is honest — without locking, market prices outcomes during voting anyway. Extended delay gives Security Council a meaningful veto window on high-impact proposals. |
| Elastic expansion | Binary to 1.8M ARM | Accommodates demand without distorting any future fundraising |
| Team allocation control | Single shared revenue-lock contract with per-beneficiary allocations; Knowable Safe is a beneficiary like any other team member | Each team member governs independently; Knowable Safe handles future contributors off-chain after release and global transfer unlock |
| Pre-crowdfund distribution | Early network allocation distributed before the crowdfund opens | Full transparency for funders |
| Recurring payments | Not supported in v1 | Steward submits monthly batches instead |
| Hop allocation model | Demand-driven ceilings, not fixed reserves | Capacity follows actual demand; no hop is guaranteed allocation it didn't earn; unused capacity rolls forward |
| Overlapping ceilings | Hop-0 and hop-1 sum to 115% of available (70/45); hop-2 has no fixed ceiling | Hop-0 and hop-1 can absorb more if the other underperforms. Hop-2's effective ceiling is floor + hop-1 leftover — it can grow arbitrarily large if earlier hops are empty, preserving full rollover flexibility |
| Hop-2 hard floor | 5% of the fund reserved — hop-2 has first claim on this capacity | Hop-2 is governance breadth and ecosystem signal. The reserved capacity ensures hop-2 can always absorb up to the floor amount regardless of earlier hop demand. Actual receipt depends on hop-2 demand. |
| Multi-hop commits from single address | Permitted; receives ARM allocation at each hop independently | $33k per-subtree ceiling (2.75% of base raise). An address invited by multiple hop-0 participants accumulates across all subtrees — no global cap, but all participation is visible in the graph. Concentration is legible, not preventable. |
| Invite window | Launch team: days 1–7 only; Hop-0 and hop-1: full 3 weeks | Narrows launch team discretion to week 1 — after that, no new hop-0 participants can be added and no new launch team invites can be issued. Live oversubscription data is visible during days 1–7, so this reduces but does not eliminate data-informed invite issuance. Hop-0 and hop-1 participants retain full flexibility throughout. |
| Rolling hop-0 additions | Launch team may add hop-0 participants during week 1 only, up to 160-participant cap | Constrained to launch team's invite window. Once added, hop-0 participants may invite throughout the full 3 weeks. |
| Hop-0 cap | 160 hop-0 participants maximum | Bounds network to ~1,840 participant slots (nodes); distinct individuals may be fewer under single-address multi-hop |
| Launch team invite budgets | 60 hop-1 + 60 hop-2 invitations, predeclared, week 1 only | Extends the initial community with allies not connected to any hop-0 participant. |
| Rollover | Unconditional — leftover always rolls forward | Rollover thresholds dropped as weak sybil protection; hop-0 selection is the real defence. Simpler contract. |
| No commitment withdrawals | Commitments are final once submitted | Eliminates gaming risk and simplifies contract; 3-week maximum lock period is known upfront |
| ARM pre-load requirement | 1,800,000 ARM loaded before window opens | Ensures claim records written at finalization are always backed by sufficient ARM; enforced by contract flag |
| Settlement model | Lazy settlement: aggregate finalization + per-user computation at claim time | `finalize()` writes only aggregate state (sale size, ceilings, hopDemand, totalAllocatedArm) — zero per-participant storage writes. `claim()` computes each participant's allocation on-the-fly from aggregate parameters + their own commitment records. Net proceeds push to treasury at finalization. ARM and refunds pull at claim time. |
| Crowdfund finalization | Permissionless — callable by anyone after deadline | All post-deadline outcomes flow through `finalize()`. Sub-minimum demand results in `refundMode = true`. No separate deadline fallback path. Someone must call `finalize()` even in obvious failure cases (permissionless, low-cost). |
| Crowdfund emergency cancel | Security Council (3-of-5 multisig), immediate effect, pre-finalization only | Speed serves participants in a genuine emergency. Abuse protection from Security Council composition, automatic unconditional refunds, and pre-finalization-only restriction — not a delay. |
| Post-finalization | No privileged roles | All privileged functions permanently inactive after finalization. `withdrawUnallocatedArm` is permissionless — anyone calls it, ARM goes to immutable treasury address. |
| Governance quiet period | 7 days after finalization; no proposals until day 8 | Gives community time to claim, delegate, and orient. Security Council handles any emergency during this window. Constructor parameter — applies once, no effect after expiry. |
| ARM claim deadline | 3 years from finalization, fixed | Predeclared term of participation, ungovernable by design |
| Automatic wind-down | Revenue threshold + deadline, both governable | Removes need for governance vote to initiate failure-case wind-down; defaults ($10k by Dec 31 2026) are conservative enough to signal genuine traction |

---

## Contract Interface

### External Functions

| Function | Caller | Parameters | Preconditions | Effects |
|---|---|---|---|---|
| `loadArm()` | Anyone (once) | — | Contract holds ≥ MAX_SALE ARM; not already called | Sets ARM-loaded flag; arms the sale (commitment window opens at configured `openTimestamp`, not at the moment `loadArm()` is called); emits `ArmLoaded` |
| `addSeed(address)` | Launch team | Hop-0 address | ARM loaded; week 1 only; hop-0 count < 160; address not already hop-0; not cancelled; not finalized | Adds address as hop-0 node; records edge from ROOT; emits `SeedAdded`; decrements hop-0 budget |
| `launchTeamInvite(invitee, fromHop)` | Launch team | Target address, inviter's hop (0 or 1; invitee joins at `fromHop + 1`) | ARM loaded; week 1 only; budget remaining for target hop; not cancelled; not finalized | Records invite edge from ROOT to invitee at `fromHop + 1`; emits `Invited(ROOT, invitee, fromHop + 1, 0)`; decrements launch team budget |
| `commit(hop, amount)` | Participant | Hop level, USDC amount | ARM loaded; pre-deadline; not cancelled; not finalized; `amount > 0`; address holds at least one participation slot at this hop (hop-0 slots from `SeedAdded`; hop-1/hop-2 slots from `Invited`) | Records commitment; transfers USDC to escrow; emits `Committed` |
| `invite(invitee, fromHop)` | Inviter | Target address, inviter's hop | ARM loaded; pre-deadline; not cancelled; not finalized; caller has available slots at `fromHop` | Records invite edge; creates a new participation slot for invitee at `fromHop + 1` (increases invitee's cap by `HOP_CAP[fromHop + 1]`); emits `Invited(caller, invitee, fromHop + 1, 0)`; decrements inviter's slot count at `fromHop` |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | Invitee | Inviter address, inviter's hop, nonce, deadline, EIP-712 signature, USDC amount | Valid EIP-712 + EIP-1271 signature; `nonce > 0`; `amount > 0`; `block.timestamp ≤ deadline`; nonce not used/revoked; inviter has available slots at `fromHop`; ARM loaded; pre-deadline; not cancelled; not finalized; USDC approved | Records invite edge + commitment atomically; creates a new participation slot for invitee at `fromHop + 1`; transfers USDC to escrow; emits `Invited(inviter, caller, fromHop + 1, nonce)` + `Committed(caller, fromHop + 1, amount)`; consumes nonce; decrements inviter's slot count |
| `revokeInviteNonce(nonce)` | Inviter | Nonce to revoke | `nonce > 0`; nonce not already consumed or revoked | Marks nonce permanently revoked; emits `InviteNonceRevoked` |
| `finalize()` | Anyone | — | Post-deadline; not finalized; not cancelled | Iterates all participants once to compute `hopDemand[]`. Writes aggregate state only: `finalized`, `finalizationTimestamp`, `saleSize`, `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`, `totalArmTransferred = 0`. If `totalAllocatedUsdc >= MINIMUM_RAISE`: transfers net proceeds to treasury, emits `Finalized(refundMode=false)`. If `totalAllocatedUsdc < MINIMUM_RAISE`: sets `refundMode = true`, no treasury transfer, emits `Finalized(refundMode=true)`. Zero per-participant storage writes. |
| `claimRefund()` | Participant | — | `refundMode == true` OR `cancelled == true`; refund not already claimed | Transfers refund USDC to caller; emits `RefundClaimed` |
| `claim(delegate)` | Participant | Delegate address | `finalized == true`; `refundMode == false`; not already claimed | Computes allocation on-the-fly via `computeAllocation(msg.sender)`. Sets `claimed[msg.sender] = true`. If within 3-year window: transfers ARM, calls `delegateOnBehalf`, increments `totalArmTransferred`. Always transfers refund USDC if any. Emits `Allocated(participant, armTransferred, refundUsdc, delegate)` + `AllocatedHop` per hop. `nonReentrant`. |
| `computeAllocation(address)` | Anyone (view) | Participant address | `finalized == true`; `refundMode == false` | Pure view function — returns `(armAmount, refundUsdc)` for the given address. Canonical computation: same logic as `claim()` minus side effects. Required for UI display of allocations before claiming. |
| `cancel()` | Security Council | — | Not finalized | Sets `cancelled` permanently; emits `Cancelled` |
| `withdrawUnallocatedArm()` | Anyone | — | `finalized == true` and within 3yr (sweeps `1,800,000 - totalAllocatedArm` — unsold only) OR `finalized == true` and past 3yr (sweeps `1,800,000 - totalArmTransferred` — unsold + unclaimed + forfeited) OR `cancelled == true` (sweeps all 1.8M) | Transfers eligible ARM to immutable treasury address. Time check determines sweep formula. |

**Hop parameter convention:** All invite functions use `fromHop` — the inviter's hop level. The invitee's hop is always `fromHop + 1` and is never passed as a parameter.

---

## Required Contract Events

| Event | Emitted by | Fields | Description |
|---|---|---|---|
| `ArmLoaded` | `loadArm()` | — | ARM pre-load verified; sale armed (commitment window opens at configured `openTimestamp`) |
| `SeedAdded` | `addSeed()` | `address seed` | New hop-0 node added; edge from ROOT |
| `Invited` | `invite()`, `commitWithInvite()`, `launchTeamInvite()` | `address inviter, address invitee, uint8 hop, uint256 nonce` | New invite edge. `hop` is the invitee's hop level. `nonce` is 0 for direct invites, `> 0` for link-based invites — enables UI to track link consumption from events alone. |
| `Committed` | `commit()`, `commitWithInvite()` | `address participant, uint8 hop, uint256 amount` | USDC committed at specific hop; amount is raw deposit (may exceed cap) |
| `InviteNonceRevoked` | `revokeInviteNonce()` | `address inviter, uint256 nonce` | Invite link nonce permanently invalidated |
| `Finalized` | `finalize()` | `uint256 saleSize, uint256 totalAllocatedArm, uint256 netProceeds, bool refundMode` | Settlement aggregates computed; `refundMode` flag distinguishes success from refundMode finalization without reading contract storage |
| `Allocated` | `claim()` | `address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate` | Per-address settlement. Emitted at claim time, one event per claiming address. `armTransferred` is actual ARM sent (0 if claimed after 3-year expiry). `refundUsdc` is actual USDC refund sent. `delegate` is the delegation target (address(0) if no ARM transferred). Success path only (not refundMode). |
| `AllocatedHop` | `claim()` | `address indexed participant, uint8 indexed hop, uint256 acceptedUsdc` | Per-hop accepted USDC (theoretical, USDC domain — not affected by ARM expiry, since expiry affects transfer timing, not sale participation). One event per (address, hop) with `acceptedUsdc > 0`. Success path only. |
| `RefundClaimed` | `claimRefund()` | `address participant, uint256 usdcAmount` | Refund USDC transferred (refundMode / cancel / pre-finalization paths only) |
| `Cancelled` | `cancel()` | — | Crowdfund permanently cancelled by Security Council |

**Event design principles:**
- Every state change emits an event. The observer reconstructs **committed state and claimed state** from events alone — `Committed`, `Invited`, `Finalized`, `Allocated`, `AllocatedHop`, `RefundClaimed`, and `Cancelled` events are sufficient for the core display.
- **Theoretical allocations before claims** require the `computeAllocation()` view function — they cannot be derived from events alone because the allocation math depends on aggregate parameters (`ceilings[]`, `hopDemand[]`) that are only stored on-chain, not emitted in event fields. The observer can call `computeAllocation(address)` for any participant after `Finalized` is emitted. **Events alone are insufficient to derive pre-claim allocations; the observer must query on-chain finalized aggregate state through `computeAllocation()`.**
- `Allocated` and `AllocatedHop` are emitted at `claim()` time on the success path only — one set of events per claiming participant. In refundMode, neither is emitted — the observer derives full-refund eligibility from `Finalized(refundMode=true)` combined with `Committed` totals.
- `Allocated.armTransferred` reports actual ARM sent, not theoretical entitlement. After 3-year expiry, `armTransferred` is 0 and `delegate` is `address(0)`, while `AllocatedHop.acceptedUsdc` still reflects the theoretical sale participation.
- `AllocatedHop` is only emitted when `acceptedUsdc > 0`. Zero-acceptance hops produce no event — the UI infers zero from absence.
- `commitWithInvite()` emits both `Invited` and `Committed` in the same transaction; the observer processes them independently.

### Gas Considerations

**Lazy settlement architecture.** `finalize()` writes only aggregate state — zero per-participant storage. Per-participant allocation computation and storage writes happen at `claim()` time, paid by each claimant. This eliminates the gas scaling problem that made eager per-participant finalization infeasible at ~800 participants.

**`finalize()` gas profile (~3-5M gas, within 30M block limit):**
- Iterates all participants once to compute `hopDemand[]`: ~800 participants × ~1.5 hops avg = ~1,200 SLOADs for commitment reads. Cold first-access is 2,100 gas; subsequent reads of the same participant's other hops are warm (100 gas). Estimated: ~2-4M gas depending on storage layout.
- Aggregate SSTOREs (hopDemand, ceilings, saleSize, finalized, timestamp, totalAllocatedArm, totalArmTransferred): ~10 SSTOREs = ~200k gas
- USDC transfer to treasury: ~65k gas
- Event + overhead: ~200k gas
- **Must be benchmarked against actual storage layout and realistic hop distribution before finalizing implementation.** Cold-read vs warm-read costs depend on storage packing.

**`claim()` gas profile (~200k gas per call, user-borne):**
- Read participant's own commitments: 1-3 SLOADs = ~6k gas
- Read aggregate parameters (ceilings, hopDemand): ~6 SLOADs = ~12k gas
- Compute allocation: negligible
- Write `claimed[msg.sender]`: 1 SSTORE = ~20k gas
- ARM transfer + `delegateOnBehalf`: ~100k gas
- USDC refund transfer (if any): ~65k gas
- Events: ~5k gas

**Participant enumeration prerequisite.** `finalize()` must iterate all participants to compute `hopDemand[]`. The contract must maintain an enumerable participant set — e.g., an `address[] participants` array populated by `commit()` and `commitWithInvite()`. If this does not already exist, it must be added. This is a load-bearing dependency for the entire lazy settlement architecture.

### EIP-712 Typed Data (Invite Links)

```solidity
bytes32 constant INVITE_TYPEHASH = keccak256(
    "Invite(address inviter,uint8 fromHop,uint256 nonce,uint256 deadline)"
);

bytes32 constant DOMAIN_TYPEHASH = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
);
```

The contract stores the domain separator at deployment (computed from the four domain fields). Signature verification uses `SignatureChecker.isValidSignatureNow(inviter, digest, signature)` from OpenZeppelin, supporting both EOA and EIP-1271 contract wallets.

Nonces are per-inviter, any unique `uint256 > 0` — nonce 0 is reserved as the sentinel value for direct invites (`invite()` emits `Invited(..., nonce=0)`). `commitWithInvite()` requires `nonce > 0` and reverts otherwise. The contract imposes no ordering requirement on valid nonces. Each nonce can be consumed (by successful redemption) or revoked (by the inviter) exactly once. A mapping `mapping(address => mapping(uint256 => bool))` tracks consumed and revoked nonces.

---

## Appendix: Allocation Pseudocode

The following pseudocode is the **specification-intent** description of the allocation algorithm. It uses simplified arithmetic for readability. The contract implementation must use **integer math throughout**: percentages as basis points (BPS), token amounts in their smallest denomination (USDC: 6 decimals, ARM: 18 decimals), floor rounding on all pro-rata splits (participants may receive fractionally less than their exact share; dust accumulates as unallocated ARM), and no floating-point operations.

**Lazy settlement note:** This pseudocode describes the allocation *algorithm* — the math that determines who gets what. Under lazy settlement, this computation is split across two contract functions: `finalize()` executes the waterfall pass (steps 1-3 below) and stores the resulting aggregate parameters (`saleSize`, effective `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`). `computeAllocation(address)` executes the per-participant allocation (step 4 equivalent) at claim time, using the stored aggregates plus the participant's own commitment records. The pseudocode below shows both passes as a single function for clarity.

**Two clean asset invariants the implementation must satisfy** (see also §Conservation invariants for the lazy settlement formulation):
- **USDC:** `netProceeds + sum(refundUsdc[p] for all p) == totalCommitted` — all deposited USDC is either sent to treasury or returned to participants; none is stranded. This is a settlement-completion identity that holds once all participants have claimed.
- **ARM:** `totalArmTransferred + sweepableArm == 1,800,000` — all pre-loaded ARM is either delivered to participants or sweepable to treasury. Standing invariant: `totalArmTransferred <= totalAllocatedArm <= 1,800,000` at all times after finalization.

**Contract preconditions (enforced before `finalize()` is called):**
- An address may commit at multiple hop levels and receives ARM allocation from each independently.
- Per-address cap at any hop = `participation_slots[(address, hop)] × HOP_CAP[hop]`. Slot sources: hop-0 from `SeedAdded`; hop-1/hop-2 from `Invited` events.
- `loadArm()` has been called; contract holds ≥ `MAX_SALE` ARM.
- The commitment deadline has passed.
- After computing allocations, if `totalAllocatedUsdc < MINIMUM_RAISE`, the contract sets both `finalized = true` and `refundMode = true` without reverting — `finalized = true` permanently disables `finalize()` and `cancel()`; `claimRefund()` activates via the `refundMode` condition. This handles both sub-minimum `capped_demand` and the base-size post-waterfall shortfall case.

```python
# Constants
TOTAL_SUPPLY      = 12_000_000
BASE_SALE         = 1_200_000       # ARM (= USDC at $1/ARM)
MAX_SALE          = 1_800_000       # ARM
MINIMUM_RAISE     = 1_000_000       # USDC — checked against totalAllocatedUsdc post-allocation
EXPANSION_TRIGGER = 1_500_000       # USDC capped demand threshold
PRICE             = 1               # Specification uses whole-unit amounts for clarity.
# Integer implementation: 1 whole ARM = 1e18 ARM units; 1 USDC = 1e6 USDC units.
# Price ratio: 1e6 USDC units per 1e18 ARM units (i.e. 1e-12 USDC units per ARM unit).
# All token amounts in the contract must use smallest units; this pseudocode uses
# whole units throughout for readability. Do not read PRICE = 1 as a unit conversion.

HOP_CEILING_BPS = {0: 7000, 1: 4500}    # BPS of available pool; hop-2 uses floor+rollover, not a BPS ceiling
HOP2_FLOOR_BPS  = 500                   # BPS of sale_size
HOP_CAP         = {0: 15_000, 1: 4_000, 2: 1_000}  # USDC per slot per hop
# Per-address cap at a given hop = participation_slots[(address, hop)] × HOP_CAP[hop]
# Slot sources by hop:
#   hop-0: count of SeedAdded events where seed=address (always 0 or 1)
#   hop-1/hop-2: count of Invited events where invitee=address and invitee_hop=hop


def allocate(commitments, participation_slots):
    """
    commitments:        list of Commitment(address, hop, usdc_committed)
    participation_slots: dict of (address, hop) -> int (number of slots at that hop)
                         hop-0 slots from SeedAdded; hop-1/hop-2 slots from Invited events
    An address may commit at multiple hops and receives ARM allocation from each.
    Per-address cap at hop = participation_slots[(address, hop)] × HOP_CAP[hop].
    Deposits above the cap are permitted; excess is refunded at settlement.
    """

    # Step 1: Aggregate multiple commitments per (address, hop),
    # capped at participation_slots[(address, hop)] × HOP_CAP[hop].
    aggregated = {}  # (address, hop) -> effective USDC (capped)
    for c in commitments:
        key = (c.address, c.hop)
        slots = participation_slots.get(key, 0)
        cap = slots * HOP_CAP[c.hop]
        aggregated[key] = min(
            aggregated.get(key, 0) + c.usdc_committed,
            cap
        )

    # Step 2: Compute capped_demand and determine sale size.
    # capped_demand = sum across ALL (address, hop) pairs — each hop counted independently.
    capped_demand = sum(aggregated.values())  # USDC
    sale_size = MAX_SALE if capped_demand >= EXPANSION_TRIGGER else BASE_SALE

    # Step 3: Reserve hop-2 floor upfront.
    # Hop-2 has first claim on this capacity; hop-0 and hop-1 compete only for available.
    hop2_floor   = HOP2_FLOOR_BPS * sale_size // 10_000
    available    = sale_size - hop2_floor

    hop0_ceiling = HOP_CEILING_BPS[0] * available // 10_000
    hop1_ceiling = HOP_CEILING_BPS[1] * available // 10_000

    def participants(hop):
        # All addresses committed at this hop, regardless of other hops they joined.
        return {addr: amt for (addr, h), amt in aggregated.items() if h == hop}

    allocations = {}      # address -> total ARM allocated (accumulated across all hops)
    hop_allocations = {}  # (address, hop) -> ARM allocated at this specific hop (for AllocatedHop events)

    # Step 4: Allocate hop-0 from available pool.
    p0 = participants(0)
    d0 = sum(p0.values())
    if d0 <= hop0_ceiling:
        for addr, amt in p0.items():
            arm = amt // PRICE
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 0)] = arm
        hop0_leftover = hop0_ceiling - d0
        eff0 = d0
    else:
        for addr, amt in p0.items():
            arm = amt * hop0_ceiling // d0 // PRICE  # floor round
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 0)] = arm
        hop0_leftover = 0
        eff0 = hop0_ceiling

    remaining_available = available - eff0

    # Step 5: Allocate hop-1 from remaining available pool.
    # Hop-0 leftover increases hop-1's effective ceiling,
    # but hop-1 can never absorb more than remaining_available.
    hop1_eff_ceiling = min(hop1_ceiling + hop0_leftover, remaining_available)
    p1 = participants(1)
    d1 = sum(p1.values())
    if d1 <= hop1_eff_ceiling:
        for addr, amt in p1.items():
            arm = amt // PRICE
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 1)] = arm
        hop1_leftover = hop1_eff_ceiling - d1
        eff1 = d1
    else:
        for addr, amt in p1.items():
            arm = amt * hop1_eff_ceiling // d1 // PRICE  # floor round
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 1)] = arm
        hop1_leftover = 0
        eff1 = hop1_eff_ceiling

    # Step 6: Allocate hop-2 from floor + any hop-1 leftover.
    # Floor capacity is always available (reserved in Step 3).
    hop2_eff_ceiling = hop2_floor + hop1_leftover
    p2 = participants(2)
    d2 = sum(p2.values())
    if d2 <= hop2_eff_ceiling:
        for addr, amt in p2.items():
            arm = amt // PRICE
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 2)] = arm
        eff2 = d2
    else:
        for addr, amt in p2.items():
            arm = amt * hop2_eff_ceiling // d2 // PRICE  # floor round
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, 2)] = arm
        eff2 = hop2_eff_ceiling

    # Step 7: Compute USDC and ARM accounting.
    #
    # USDC accounting:
    #   net_proceeds  = USDC actually sold = ARM allocated × PRICE (NOT eff0+eff1+eff2,
    #                   which overcounts dust from floor rounding)
    #   refunds       = deposited USDC not allocated → claimable via claimRefund()
    #   invariant:    net_proceeds + sum(refunds) == sum(total_deposited)
    #
    # ARM accounting:
    #   allocated_arm = ARM owed to participants → claimable via claim() (= totalAllocatedArm in lazy settlement)
    #   unsold_arm    = ARM never allocated → sweepable via withdrawUnallocatedArm() immediately
    #   invariant:    allocated_arm + unsold_arm == MAX_SALE
    #   (After 3yr, sweep formula changes to 1,800,000 - totalArmTransferred — see §withdrawUnallocatedArm)

    allocated_arm = sum(allocations.values())                  # ARM
    net_proceeds  = allocated_arm * PRICE                      # USDC (floor-rounding dust stays in contract as unsold_arm)
    unsold_arm    = MAX_SALE - allocated_arm                   # ARM — always uses MAX_SALE, not sale_size
    # 1,800,000 ARM is preloaded regardless of whether the sale expands.
    # In a base sale, the 600,000 expansion reserve is also immediately sweepable.

    # Post-allocation minimum raise check.
    # IMPORTANT: must NOT revert. If net_proceeds < MINIMUM_RAISE, set refundMode = true.
    # All provisional allocation/refund calculations above are DISCARDED.
    # claimRefund() in this branch returns each address's full raw deposited USDC.
    if net_proceeds < MINIMUM_RAISE:
        total_deposited = {}
        for c in commitments:
            total_deposited[c.address] = total_deposited.get(c.address, 0) + c.usdc_committed
        # refundMode = true: each address claims total_deposited[address], no ARM allocated
        full_refunds = {addr: deposited for addr, deposited in total_deposited.items()}
        # Verify: sum(full_refunds) == sum(total_deposited); no ARM allocated
        assert sum(full_refunds.values()) == sum(total_deposited.values())
        # No Allocated or AllocatedHop events emitted in refundMode.
        return None, None, full_refunds, MAX_SALE, 0

    total_deposited = {}
    for c in commitments:
        total_deposited[c.address] = total_deposited.get(c.address, 0) + c.usdc_committed

    refunds = {}
    for addr, deposited in total_deposited.items():
        allocated_usdc = allocations.get(addr, 0) * PRICE
        refunds[addr] = deposited - allocated_usdc  # always >= 0

    # Verify invariants (implementation must enforce these):
    # Under lazy settlement, these are verified as:
    #   USDC: netProceeds + sum(refundUsdc[p]) == totalCommitted (settlement-completion identity)
    #   ARM:  totalArmTransferred + sweepableArm == 1,800,000 (standing invariant)
    # The pseudocode below shows the algorithmic equivalents.
    assert net_proceeds + sum(refunds.values()) == sum(total_deposited.values())  # USDC
    assert allocated_arm + unsold_arm == MAX_SALE                                  # ARM
    # Settlement invariant: per-hop accepted USDC converts to aggregate ARM for each address.
    # Under lazy settlement, this is verified by computeAllocation() — the canonical view function.
    # AllocatedHop emits acceptedUsdc (USDC domain); Allocated emits armTransferred (ARM domain, actual).
    for addr in allocations:
        per_hop_sum = sum(arm for (a, h), arm in hop_allocations.items() if a == addr)
        assert per_hop_sum == allocations[addr]

    # Return values map to lazy settlement:
    #   allocations     -> computeAllocation(address).armAmount (theoretical entitlement)
    #   hop_allocations -> AllocatedHop(address, hop, acceptedUsdc) emitted at claim() time
    #   refunds         -> computeAllocation(address).refundUsdc
    #   At claim(), Allocated emits armTransferred (actual, 0 after expiry) and refundUsdc (actual)
    return allocations, hop_allocations, refunds, unsold_arm, net_proceeds
```

**Key properties the implementation must preserve:**

| Property | Guarantee |
|---|---|
| Hop-2 reserved capacity | Hop-2 always has first claim on `HOP2_FLOOR_BPS × sale_size`; actual receipt depends on hop-2 demand |
| USDC conservation | `net_proceeds + sum(refunds) == sum(total_deposited)` (settlement-completion identity — holds once all participants have claimed) |
| ARM conservation | `totalArmTransferred + sweepableArm == 1,800,000` (sweepableArm = preloaded - totalArmTransferred) |
| Minimum raise | If `totalAllocatedUsdc < MINIMUM_RAISE` after aggregate computation, contract sets `refundMode = true` (no revert — state must be preserved for `claimRefund()` to work) |
| Integer rounding | All pro-rata splits floor-rounded per participant per hop; refunds round up (participant never under-refunded); dust accumulates in sweepable pool |
| Order-independence | All participant entitlements fixed at `finalize()` time; claims may occur in any order; no claim changes any other participant's entitlement |

**Asset flows post-finalization:**

| Asset | When | Mechanism |
|---|---|---|
| Net USDC proceeds | At finalization | Push to immutable treasury address |
| Allocated ARM (within 3yr) | After finalization, within 3-year window | Pull: participant calls `claim(delegate)` |
| Success-path USDC refunds | After finalization, no expiry | Pull: participant calls `claim(delegate)` — refund portion always payable |
| RefundMode/cancel USDC refunds | After finalization or cancel, no expiry | Pull: participant calls `claimRefund()` |
| Unsold ARM | After finalization | Pull: anyone calls `withdrawUnallocatedArm()` (sweeps `1,800,000 - totalAllocatedArm`) |
| Unclaimed + forfeited ARM | After 3-year claim deadline | Pull: anyone calls `withdrawUnallocatedArm()` (sweeps `1,800,000 - totalArmTransferred`) |
