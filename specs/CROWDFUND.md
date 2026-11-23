# Armada Crowdfunding Spec

## Overview

Armada bootstraps governance through a word-of-mouth whitelist crowdfund. The allocation mechanism is algorithmic and predeclared. Once the commitment window opens, participant allocations are determined entirely by the rules of the contract, not by launch team discretion. The initial network shape (who is added as a hop-0 participant, and who the launch team invites directly) is determined by the launch team before and during the window. This is intentional and disclosed.

### Parameters

| Parameter | Value |
|---|---|
| Purpose | Governance bootstrapping |
| Minimum fund | 250,000 USDC ($250k), checked against capped demand |
| Sale size | 1,800,000 ARM ($1.8M); `BASE_SALE == MAX_SALE`, so there is no elastic expansion |
| Expansion trigger | 1,800,000 USDC (equal to the sale size, so it has no effect) |
| Percent of supply | Up to 15% (1.8M of 12M ARM) |
| Price | 1.00 USDC ($1.00) per ARM |
| Launch team payment | 250,000 USDC ($250k) from the proceeds of a successful sale; the rest goes to the treasury |
| Timing | Testnet product |

---

## Token Distribution

**Total supply: 12,000,000 ARM**

| Allocation | ARM | % | Unlock | Voting Power |
|---|---|---|---|---|
| Crowdfund | 250,000 - 1,800,000 sold | 2-15% | Governance proposal | Active once claimed and delegated |
| Early network | 2,400,000 | 20% | Revenue milestones | Revenue-gated |
| Treasury | 7,800,000 - 9,350,000 (including swept unsold crowdfund ARM) | 65-78% | Governance-controlled | None |

### Pre-Crowdfund Distribution

Before the crowdfund opens, the following revenue-locked allocations are distributed and published:

**Early Network Allocation (2,400,000 ARM):** Covers launch team, ecosystem contributors, and a reserve for future contributors. All held in a single shared revenue-lock contract with per-beneficiary allocations. Publish every initial beneficiary/distribution-contract address and amount, the reserve cap, allocator Safe, and wind-down fallback before the crowdfund opens. Later reserve grants are irrevocable on-chain assignments and must be disclosed as they occur. See REVENUE_LOCK.md for the full contract spec.

**Transparency:**

Crowdfund participants can evaluate the full distribution (ie. who holds what and under what terms) before committing.

### Early Network Allocation

The early network allocation (2,400,000 ARM, 20%) is held in a shared RevenueLock with immutable beneficiary allocations. The reserve is held for `RevenueReserveDistributor`, whose fixed 2-of-3 allocator Safe assigns irrevocable grants on-chain. Grants inherit completed milestones and anyone can sponsor their payout. Exact category amounts follow the approved cap table; 360,000 ARM is only a worked example. The separate Merkle airdrop path is not replaced by individual RevenueLock entries and its integration must be reconciled in the launch schedule. See REVENUE_LOCK.md and REVENUE_RESERVE_DISTRIBUTOR.md.

**Properties:**
- Revenue-locked transferability (same schedule as all early network tokens)
- Voting power unlocks proportionally with revenue milestones
- Recipients do not vote as a bloc

**Constraints:**
- Cannot change the revenue-lock schedule
- Cannot pull from treasury or other allocations
- Reserve grants remain bounded by the original revenue milestones and lifetime cap. The whitelisted distributor pays recipients directly, including before global transfer unlock. Assignment ends at wind-down; the unassigned remainder becomes the allocator's entitlement, payable only at the frozen unlocked percentage. Disclose the allocator's controlling parties and this conditional entitlement.

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

This is a trusted-network crowdfund, not viral growth. Participation requires a placement by the launch team or an invite link from a team-owned wallet. There are two contribution tiers and one operational tier:

- **Known contributors (hop 0):** added by the launch team, $100,000 cap each.
- **Team inviter wallet (hop 1):** one team-owned wallet placed by the launch team. Its cap is $0 (it does not contribute); it holds 100 invite slots for bringing contributors into hop 2.
- **Invited contributors (hop 2):** placed directly by the launch team, or admitted by redeeming the team wallet's invite link. $10,000 cap per invite received; an address can receive up to 20 hop-2 invites, for up to $200,000.

Allocation gives hop 2 first priority for a $300,000 reserve (`HOP2_RESERVE_USDC`): hop 2 receives `min(hop-2 demand, $300k)` before anyone else. The known tier then fills up to the rest of the $1.8M sale ($1.5M, plus any part of the reserve hop 2 leaves unused). Any capacity the known tier leaves unused rolls back to hop 2 above its reserve. Within a tier, oversubscription is resolved pro-rata, and only when total capped demand exceeds the sale. The launch team's placement budget, team-wallet invites and commitments all stay open for the whole 5-day window (extendable to at most 15 days from open).

### Initial Network

The people creating Armada are inviting their network of allies to help form the Armada community. Hop-0 participants, and the initial invitations from the launch team, are the first nodes in a trust network that extends outward through word of mouth.

Hop-0 selection criteria are determined by the launch team based on demonstrated alignment, contribution, and long-term interest in privacy infrastructure.

**Maximum hop-0 count: 500.** The total number of hop-0 participants is capped at 500 (`MAX_SEEDS`, a `uint16`). This bounds the structural network size at 1,101 participant nodes: 500 hop-0 + 1 team wallet + 100 team-wallet invites + 500 launch-team hop-2 placements (hop-2 invite stacking adds slots to an existing node, not new nodes). That is below the 1,800-node `MAX_FINALIZE_NODES` cap, so the budgets, not the node cap, bound `finalize()` gas (see the gas note below). Because the same address may occupy multiple hop levels, the number of distinct individuals may be lower.

**Hop-0 additions.** The launch team may add new hop-0 participants at any time during the commitment window, up to the 500-participant cap. Participants added later naturally have less of the window remaining. Hop-0 participants cannot invite (`HOP0_MAX_INVITES = 0`).

**Launch team hop-1 budget: the team inviter wallet.** The launch team holds a predeclared budget of 1 hop-1 placement (`LAUNCH_TEAM_HOP1_BUDGET`). It is a team-owned wallet, not a contributor: the hop-1 cap is $0, so any USDC the team wallet commits is refunded in full at settlement. The team wallet holds 100 invite slots (`HOP1_MAX_INVITES`), used through the committer app to sign invite links for outside contributors, who join at hop 2. The team wallet must sit at hop 1 because an invite link places the redeemer one hop below the signer. The team wallet can also use its slots on itself, taking $10,000 hop-2 positions (up to the 20-invite stacking cap); this is visible in the graph like any other self-invite.

The team wallet appears in the invite graph with the launch team address as inviter. In the `(address, hop)` node model, launch-team-issued invites originate from a designated `(launch_team_address, ROOT)` sentinel node — a fixed address with no hop level and no cap, whose sole role is to issue the predeclared launch team budget. This node is not a participant and makes no commitment.

**Launch team hop-2 invite budget.** The launch team also holds a predeclared budget of 500 direct hop-2 placements (`LAUNCH_TEAM_HOP2_BUDGET`, a `uint16`), each adding one $10,000 slot. Placing the same address more than once stacks slots (up to 20 per address) and consumes one budget unit per placement. These participants receive no invite rights (consistent with all hop-2 participants). Budget is fixed for the duration of the crowdfund.

**No financial incentive to invite.** Participants receive no allocation benefit from others' commitments. There is no referral bonus, no token reward, and no increase in a participant's own allocation from someone else's commitment. Invitations are an act of community-building, not a financial strategy. This keeps the invite graph honest: people invite those they genuinely want in the community, not those most likely to maximize their own return.

### Hop Structure

| Hop | Description | Priority | Cap per slot | Invites | Slots per address |
|---|---|---|---|---|---|
| 0 | Known contributors (max 500, launch team) | Second: up to the sale less hop-2's reserved fill | $100,000 | 0 | 1 |
| 1 | Team inviter wallet (max 1, launch team) | Third (demand is always $0) | $0 | 100 | 1 |
| 2 | Invited contributors (team-wallet links + up to 500 launch-team placements) | First for the $300,000 reserve; last for anything above it | $10,000 | 0 | Up to 20 |

The launch team's placement budgets (1 hop-1, 500 hop-2) are separate from hop-0 and from the team wallet's invite slots. Launch team placements may be issued at any time during the commitment window.

The allocation, with `S` the sale size, `d_h` each hop's capped demand and `a_h` its allocation:

1. `a2_reserved = min(d2, HOP2_RESERVE_USDC)`: hop 2 is served first, up to $300,000.
2. `a0 = min(d0, S − a2_reserved)`: hop 0 takes up to the rest of the sale. Its earmark is `S − $300k` ($1.5M), plus whatever part of the reserve hop 2 leaves unused.
3. `a1 = min(d1, S − a2_reserved − a0)`: hop 1 takes from what remains (always 0, since its cap is $0).
4. `a2 = a2_reserved + min(d2 − a2_reserved, S − a2_reserved − a0 − a1)`: hop 2 takes any capacity hop 0 and hop 1 left unused, above its reserve.

Unused reserve rolls to hop 0, and unused hop-0 capacity rolls back to hop 2. Total allocation equals `min(capped demand, S)`. A hop is pro-rated only when total capped demand exceeds `S`. The final per-hop allocations are stored in `finalCeilings[h]`. The `hopConfigs[h].ceilingBps` field is kept for the getter's shape but is 0 for every hop and unused.

### Allocation Amounts

**Sale size ($1.8M; there is no expanded size):**

| Hop | Guaranteed capacity | Maximum allocation |
|---|---|---|
| 2 | `min(d2, $300,000)`, served first | $1,800,000 if hop 0 has no demand |
| 0 | `min(d0, $1,500,000)` (the sale less hop 2's reserved fill, which is at most $300,000) | $1,500,000 when hop 2 fills its reserve; up to $1,800,000 if hop 2 has no demand |
| 1 | None | $0 (its cap is $0, so its demand, and therefore its allocation, is always zero in practice) |

Fifteen known contributors at their full $100,000 cap fill hop 0's $1.5M earmark. When hop-2 demand is below $300,000, the known tier can take the unused part of the reserve; when known-tier demand is below its earmark, hop 2 can take the rest.

### Invitation Limits

Invitation limits are hop-specific and predeclared:

- Hop-0 → may not invite
- Hop-1 (the team wallet) → may issue up to 100 invites to hop-2
- Hop-2 → may not invite

Invitations are signed on-chain (inviter → invitee, with hop level). The invite graph is defined over `(address, hop)` nodes, not bare addresses. This means:

- The same address may appear at multiple hop levels as a distinct node at each
- An invite edge connects `(inviter_address, inviter_hop)` → `(invitee_address, invitee_hop)`
- The team wallet inviting its own address to hop-2 creates a self-loop edge, visible as such in the graph
- Invite slot consumption is per `(address, hop)` node: a hop-1 node has 100 outgoing invite slots; hop-0 and hop-2 nodes have none. **Each invite to a given hop creates a participation slot, up to a per-hop stacking cap (`maxInvitesReceived`): 1 at hop 0 and hop 1, 20 at hop 2.** A further invite to an already-invited hop-2 node adds a slot (up to 20); a second invite to a hop-0 or hop-1 node reverts. The address's effective cap at that hop equals `participation_slots[(address, hop)] × HOP_CAP[hop]`: at most $100,000 at hop 0 and $200,000 (20 × $10,000) at hop 2. For entity-level capture analysis, see the Self-Filling section.
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
- **Bearer credential.** The link can be used by anyone who has it. The inviter does not choose the recipient — the first person to redeem the link becomes the invitee. Share links privately. Because the signature does not bind to the invitee's address, a pending `commitWithInvite()` transaction is front-runnable: a mempool observer can extract the signature and submit a competing transaction. The committer app mitigates this by recommending private transaction submission (e.g., Flashbots Protect on Ethereum mainnet), which avoids public broadcast before inclusion. This is a UI-layer mitigation, not a protocol guarantee. It matters more because hop 2 is served first from its $300,000 reserve and one address can stack up to 20 links: a stolen link is a $10,000 slot with first priority, and a front-runner can collect several onto one address. See CROWDFUND_COMMITTER.md for implementation details.
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

The per-hop stacking cap (`maxInvitesReceived`) is 1 at hop 0 and hop 1, and 20 at hop 2.

- **Hop 2 (stacking).** Each further invite to an existing hop-2 node — from the same inviter, a different inviter, a link redemption, or a launch-team placement — adds one $10,000 slot and consumes the inviter's slot (or one unit of the launch team's hop-2 budget). It does not create a new node. Once the node holds 20 slots, a further invite reverts with `max invites received` and consumes nothing.
- **Hop 0 and hop 1.** Once an address holds a slot, any further invite to that node reverts with `max invites received`, and no invite slot is consumed.

The same address may still be invited at a *different* hop (for example a known contributor also placed at hop 2), which is a separate node.

`invitedBy` records the first inviter for each `(address, hop)` node. Later stacked invites appear as further `Invited` events in the graph.

#### Invite Revocation

Invites issued via the direct path (`invite()`) are irrevocable — once the on-chain transaction confirms, the invitee has a permanent position.

Invite links (Path A) can be revoked before redemption by calling `revokeInviteNonce(nonce)`. This permanently invalidates the nonce. The revoked link will fail if anyone attempts to redeem it. Revocation does not free the invite slot — the slot is not consumed until a link is successfully redeemed.

### Self-Filling and Max Single-Entity Capture

A participant may commit at multiple hop levels using a single address, and receives ARM allocation from each hop they participate in, subject to that hop's per-slot cap and pro-rata rules.

With stacking capped at 1 at hop 0 and hop 1 and at 20 at hop 2, the maximum any single address can hold is:

| Hop | Per-slot cap | Max slots per address | Max USDC (single address) |
|-----|-------------|---------------------|--------------------------|
| Hop-0 | $100,000 | 1 (added by the launch team) | $100,000 |
| Hop-1 | $0 | 1 (the team wallet only) | $0 |
| Hop-2 | $10,000 | 20 (launch-team placements and/or team-wallet invites) | $200,000 |
| **Total** | | | **$300,000** |

Hop-0 participants cannot invite, so there is no self-fill path for known contributors: a known contributor reaches hop 2 only if the launch team or the team wallet places them there. Every hop-2 slot is issued by the launch team, either directly or through the team wallet's invite links, so an address reaches $200,000 at hop 2 only by receiving 20 team-issued invites (for example, by redeeming 20 team-wallet links). The team wallet can self-invite into hop 2 (its $0 hop-1 cap means it contributes nothing at hop 1). $300,000 out of the $1.8M sale is 16.7%.

Participating across hops or holding several known-tier positions using separate wallets is also permitted. Graph edges are visible, but same-entity control across separate wallets cannot be proven on-chain.

The actual deterrents to governance concentration remain:

1. **Real capital required at every slot.** Oversubscription scales everyone back pro-rata.
2. **Launch-team selection.** Every known contributor and the team wallet are placed by the launch team; outside contributors enter only through team-issued links.
3. **Graph visibility.** The full invite graph is public in real time. Multi-hop participation by a single address is fully legible.
4. **Governance concentration has low ROI pre-revenue.** Accumulating votes in a protocol with a testnet product is not obviously valuable.

Residual risk — a known contributor, or several wallets controlled by one entity, concentrating votes — is primarily mitigated by launch-team selection. The mechanism does not make it impossible; it makes it expensive and bounded. Same-address multi-hop is fully visible on-chain; multi-wallet participation is visible in graph shape but same-entity control is not provable.

---

## Crowdfund Mechanics

### Timeline

| Phase | Duration |
|---|---|
| Launch team invite window | Days 1–5 (closes at the commitment deadline) |
| Team-wallet (hop-1) invite window | Days 1–5 |
| Commitment window | Days 1–5 (5 days, extendable to at most 15 days from open) |

The launch team's invite budget (hop-0 additions, the hop-1 team wallet, hop-2 placements) may be issued at any point during the commitment window. The team wallet may likewise issue invitations, and invite links may be redeemed, right up to the commitment deadline. Keeping launch-team discretion open for the whole sale lets the team respond to live subscription data until the deadline, at the cost of participants having no final period in which launch-team actions are frozen. Every launch-team action is public on-chain and recorded in the decision log (OPERATIONS.md §10). A placement made late in the window leaves the invitee little time to commit, and still consumes a `MAX_FINALIZE_NODES` slot whether or not they commit. The launch-team window closes at the commitment deadline (`launchTeamInviteEnd == windowEnd`); because the launch-team check is strict (`< launchTeamInviteEnd`), the launch team is closed out at that final second while participant invites and commits (`<= windowEnd`) remain open.

**Window extension.** While the window is still open (`block.timestamp <= windowEnd`), the launch team may call `extendWindow(newEnd)` to move the commitment deadline later. Both `windowEnd` and `launchTeamInviteEnd` move together, so commits, participant invites, and launch-team whitelisting all stay open until the new deadline. The window can be extended repeatedly, but only ever later, and never beyond `windowStart + MAX_WINDOW_DURATION`. It cannot be shortened or closed early. Once `windowEnd` has passed, no extension is possible: anyone may finalize at that point, and an extension would reopen a closed sale. Each extension emits `WindowExtended(previousEnd, newEnd)`. `MAX_WINDOW_DURATION` is 15 days. Operationally, the launch team extends in steps of 5 days, at most twice (5 + 5 + 5 = 15 days); the contract enforces only the 15-day cap. The step rule is deliberately operational rather than contract logic (see the decisions table, "Extension steps"). The days 1–5 figures above describe the base window; an extension lengthens every row of the timeline table by the same amount.

### Commitment

- **Currency:** USDC
- **Method:** Commit to escrow contract
- **Multi-hop commits from the same address are permitted.** An address may commit at multiple hop levels and receives ARM allocation from each hop it participates in. This makes entity-level participation unambiguously legible on-chain: a known contributor who is also placed at hop 2 is visibly doing so, and receives the ARM from both pools.
- **Multiple commitments:** A participant may commit multiple times to any hop. Commitments from the same address at the same hop are aggregated into a single running balance, capped at `participation_slots[(address, hop)] × HOP_CAP[hop]` for allocation purposes (one slot at hop 0 and hop 1, up to 20 at hop 2).
- **Visibility:** Address, amount, hop, and invite edges are all public in real time
- **No withdrawals:** Commitments are final once submitted. Participants cannot withdraw USDC before the deadline. The commitment window is 5 days and can be extended by the launch team up to a maximum of `MAX_WINDOW_DURATION` (15 days) from the open timestamp (see §Timeline, Window extension); participants should only commit amounts they are prepared to lock for that maximum period.

Real-time aggregate statistics show current commitment levels per hop throughout the window, allowing participants to observe oversubscription before committing. **Per-hop totals are the canonical display** — each hop shows the effective demand committed to that hop, regardless of whether any addresses also participate at other hops. An address committed at hop-0 and hop-1 contributes to both hop totals independently. This means the sum of all displayed per-hop totals may exceed the sale size, which is expected and correct — it reflects genuine multi-hop demand that will be allocated and scaled per hop.

### ARM Pre-Load Requirement

**1,800,000 ARM (MAX_SALE) must be present in the crowdfund contract before the commitment window opens.** The crowdfund contract enforces this with a deployment-time flag — the commitment function reverts until ARM is loaded and verified. This ensures participant claim records written at finalization are always backed by sufficient ARM.

Deployment sequence:
1. Deploy ARM token — constructor mints the entire 12M supply to the deployer (`initialHolder`).
2. Deploy `ArmadaCrowdfund` with the ARM token address (already known from step 1), treasury address, launch-team address (which also receives the team payment), security-council address, and timing parameters.
3. Deployer calls `armToken.transfer(crowdfundContract, 1_800_000e18)` (at least MAX_SALE) to seed the crowdfund's ARM balance.
4. Call `loadArm()` on the crowdfund to verify balance and set the flag.

No CREATE2 is used — the crowdfund address is resolved at conventional deploy time and passed back to subsequent transfer calls.

`loadArm()` may be called before or at the configured open timestamp. If called in advance, the contract is armed but `commit()` reverts until the open timestamp is reached. `addSeed()` and `launchTeamInvite()` are similarly gated to the launch-team window (which begins at the open timestamp) and must not be called before the window is active.

5. Commitment window opens at the configured open timestamp

### Finalization

After the commitment window closes, finalization is permissionless — anyone may call `finalize()` once the commitment deadline has passed. There is no minimum raise precondition on `finalize()` itself — the contract always runs the allocation math and determines the outcome:

- If `totalAllocatedUsdc >= MINIMUM_RAISE`: success path (ARM allocated, $250,000 team payment to the launch team, the rest of the proceeds to treasury)
- If `totalAllocatedUsdc < MINIMUM_RAISE`: sets `refundMode = true` (full refunds, no ARM allocated)

This means every post-deadline outcome flows through `finalize()`. There is no separate "deadline fallback" path where refunds become available without finalization. A participant may withdraw their full deposited USDC via `claimRefund()` if and only if **any** of these conditions hold:

1. `refundMode == true` — set by `finalize()` when `totalAllocatedUsdc < MINIMUM_RAISE`
2. `cancelled == true` — Security Council invoked `cancel()`

No privileged action or separate function is required — the eligibility check is built into `claimRefund()` itself. Someone must call `finalize()` post-deadline for refunds to activate in the sub-minimum case, but the call is permissionless and low-cost.

When `finalize()` is called:

> `finalize()` writes only aggregate state — zero per-participant storage writes. Individual allocations are computed on-the-fly at `claim()` time using aggregate parameters stored by `finalize()` plus the participant's own commitment records (already on-chain from `commit()`). This is the lazy settlement architecture.

1. **Pre-allocation minimum check:** if capped demand is below `MINIMUM_RAISE` ($250,000 USDC), `finalize()` sets `refundMode = true` and stops. Otherwise the crowdfund size is determined (base or expanded, based on total capped demand; both are $1.8M, so the size is always $1.8M)
2. **Per-hop allocations are calculated via the reserve-and-rollover pass:** hop-2's reserved fill (`min(d2, $300k)`) first, then hop 0 up to the rest of the sale, then hop 1 from what remains, then hop 2's demand above its reserve from whatever is left (see §Hop Structure). The stored `ceilings[hop]` values (`finalCeilings` in the contract) are **each hop's final allocation** — not a configured percentage. These are the numbers `computeAllocation()` uses directly.
3. **Per-hop aggregate demand is computed:** `finalize()` iterates all participants once to compute `hopDemand[hop]` — the sum of `effectiveUsdc(p, hop)` for all participants at that hop, where `effectiveUsdc(p, hop) = min(committed[p][hop], slotCount[p][hop] * HOP_CAP[hop])`. **Multiple slots per hop per address is a hard requirement** — the entire cap model, self-fill analysis, and `computeAllocation()` logic depend on `slotCount[p][hop]` being a counter that increments with each invite received. If the contract models caps as a single boolean "has access to this hop" rather than a slot count, this spec is incorrect and the allocation math must be redesigned.
4. **Aggregate allocation is computed:** `totalAllocatedUsdc = sum(min(hopDemand[hop], ceilings[hop]))` across all hops. `totalAllocatedArm = totalAllocatedUsdc * ARM_PER_USDC_RATE`.
5. **Post-allocation minimum raise check:** if `totalAllocatedUsdc < MINIMUM_RAISE ($250,000 USDC)`, the contract sets **both `finalized = true` and `refundMode = true`** and stops — no treasury transfer, no aggregate recording beyond the flags. Setting `finalized = true` permanently disables further calls to `finalize()` and `cancel()`. **In this branch, every participant may call `claimRefund()` to withdraw their full deposited USDC** — not a pro-rata refund, but the complete raw amount they deposited. **`claim()` reverts when `refundMode == true`.** Total allocation equals `min(capped demand, sale size)`, so once capped demand clears the minimum, allocation does too: this post-allocation branch is unreachable under the current constants, and refund mode in practice means capped demand below $250,000. The check is kept as a guard; finalization must not revert in either branch.
6. **Aggregate state is written:** `finalized = true`, `finalizationTimestamp`, `saleSize`, `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`, `totalArmTransferred = 0` (counter incremented by `claim()` when ARM is actually sent)
7. **Net USDC proceeds are paid out immediately** — `netProceeds = totalAllocatedUsdc` (USDC domain — computed directly from accepted USDC, not from `totalAllocatedArm * PRICE` which can diverge by rounding dust). When any hop is pro-rated, a rounding buffer of `participantNodes.length` USDC units is held back (it covers floor-division dust in per-participant refunds); without pro-rating nothing is held back. From the remaining `distributable` amount, `TEAM_PAYMENT_USDC` ($250,000, bounded by `distributable`) is transferred to the immutable `launchTeam` address, emitting `LaunchTeamPaid(recipient, amount)`, and the rest goes to the treasury, in the same transaction. At exactly the $250,000 minimum the launch team receives $250,000 and the treasury nothing. The team payment is a direct transfer from the crowdfund contract, so it does not count toward the treasury's outflow limits.

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

**Implementer note:** The `ceilings[hop]` and `hopDemand[hop]` values used in `computeAllocation()` are stored by `finalize()` after the allocation pass (see appendix pseudocode steps 3-6). They are each hop's final allocation, not configured values from the hop table (`hopConfigs[h].ceilingBps` is 0 and unused). Do not recompute the allocation pass inside the view function.

### Rounding

- **`acceptedUsdc`**: floor division at participant level, per hop, then summed. A hop ceiling may not be fully allocated (floor of each participant's share leaves residual capacity). This is intentional — the dust is not distributed.
- **`refundUsdc = committedUsdc - acceptedUsdc`**: because `acceptedUsdc` floors, refund effectively rounds up. Participant is never under-refunded.
- **`armAmount = totalAcceptedUsdc * ARM_PER_USDC_RATE`**: floor. Participant never over-receives ARM.
- **Dust sink:** treasury for ARM: residual ARM (from rounding across all participants) becomes part of the unsold/sweepable pool. USDC rounding dust (only when a hop is pro-rated) stays in the crowdfund contract, bounded by the `participantNodes.length` rounding buffer held back from the treasury transfer.

### Conservation invariants

**Settlement-completion accounting identities** (hold once all participants have claimed — not standing invariants at arbitrary intermediate times):

```
sum(armTransferred[p] for all claimed p) + sweepableArm == preloaded ARM (≥ 1,800,000)
  where sweepableArm = preloaded ARM - totalArmTransferred

sum(refundUsdc[p] for all claimed p) + teamPayment + treasuryProceeds + contractDust == totalCommitted
  where teamPayment + treasuryProceeds == netProceeds - roundingBuffer
  and contractDust <= roundingBuffer (participantNodes.length USDC units if any hop is pro-rated, else 0)
```

**Standing invariants** (hold at all times after finalization):

```
totalArmTransferred <= totalAllocatedArm <= 1,800,000 ARM
USDC balance in contract == totalCommitted - teamPayment - treasuryProceeds - sum(refunds paid out)
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

`claimRefund()` remains exclusively for refundMode / cancel / pre-finalization paths. Success-path refunds go through `claim()`. **There is no separate refund-only function for the success case** — a participant who wants their USDC refund must call `claim()`, which also handles the ARM portion. A participant whose allocation is zero ARM (for example the team wallet, whose commit is refunded under its $0 cap) calls `claim(address(0))`: the delegate is only required when ARM is transferred (transferring it within the 3-year window, or forfeiting it after expiry). This is a deliberate tradeoff: bundling refunds into `claim()` avoids a separate per-participant refund storage write in `finalize()` and keeps the lazy settlement architecture clean, at the cost of requiring every participant — even those with small oversubscription refunds — to engage the full claim path.

Refunds are pull-based — participants call `claimRefund()` once eligible (see the three-condition eligibility rule above). This avoids gas grief from iterating over all participants in a single transaction. Refunds via `claimRefund()` do not expire.

ARM claim remains a separate participant-initiated step (one transaction per claimant). USDC net proceeds flow to the launch team (team payment) and the treasury at finalization regardless of whether participants have claimed their ARM or refunds.

Crowdfund tokens are not revenue-gated, but voting power only becomes active once ARM is claimed and delegated. Allocated-but-unclaimed ARM is vote-inert regardless of any governance unlock proposal that passes.

**Governance quiet period: 10 days after finalization.** No governance proposals may be submitted until day 11 post-finalization. This gives the community time to claim, delegate, and orient before governance begins. Any emergency during this window is handled by the Security Council (veto, coordinated response) — it does not require a governance vote. The quiet period is a one-time bootstrapping measure — a compile-time governor constant that applies once and has no effect after expiry.

**Veto bootstrap: 70 days after finalization.** Until 70 days after finalization (quiet period included), a Security Council veto is final: the vetoed proposal is cancelled and no ratification vote is created. Before finalization and after the 70 days, every veto triggers the normal ratification vote. See GOVERNANCE.md §Veto mechanism.

**Early-claim governance risk.** Voting power uses Compound-style point-in-time checkpointing — there is no time-weighted average. An address that claims and delegates immediately after finalization has its full balance active with no averaging period. Quorum at proposal creation is measured against circulating ARM at that block — which, immediately after finalization, is essentially only the ARM that has been claimed, since unclaimed ARM in the crowdfund contract and unreleased ARM in the revenue-lock contract are excluded from the denominator (see GOVERNANCE.md §Quorum denominator). If very few participants have claimed, a single early claimer with 5,000+ ARM could meet proposal threshold and create a vote where quorum is a fraction of the full crowdfund supply. The 48-hour proposal delay and 10-day quiet period are the only buffers. Participants are strongly encouraged to claim and delegate promptly after finalization. **This is an accepted design choice, not an unsolved problem** — additional mechanical buffers (e.g., time-weighted voting, minimum claimed supply before governance activates) would add complexity to the ARM token or governor that contradicts the "~50 lines of custom code on OZ primitives" constraint. The Security Council provides emergency response during this window if needed.

**Claim deadline: 3 years from finalization.** The deadline is fixed and cannot be extended — it is a predeclared term of participation, not a governance parameter. Exact boundary: `claim()` is permitted when `block.timestamp <= finalizationTimestamp + 3 years`; `withdrawUnallocatedArm()` may sweep unclaimed ARM only when `block.timestamp > finalizationTimestamp + 3 years`.

**`withdrawUnallocatedArm()` eligibility — three windows with time-conditional sweep amounts:**
- **Immediately post-finalization, before 3-year deadline (`finalized == true && block.timestamp <= finalizationTimestamp + 3 years`):** sweeps `balance - (totalAllocatedArm - totalArmTransferred)` — all ARM not allocated to any participant, including any ARM preloaded beyond MAX_SALE. Does not touch allocated-but-unclaimed ARM — participants may still claim.
- **After the 3-year claim deadline (`finalized == true && block.timestamp > finalizationTimestamp + 3 years`):** sweeps all ARM not actually delivered to participants — all ARM not actually delivered to participants. This includes unsold ARM, allocated-but-never-claimed ARM, and ARM forfeited by participants who claimed after expiry (received refund only). `totalArmTransferred` is the running counter incremented by `claim()` when ARM is actually sent. This is a **semantic expansion** from the pre-3yr sweep — the function now sweeps unsold + unclaimed + forfeited. The time check determines which formula applies.
- **After `cancel()`:** sweeps all preloaded ARM — the crowdfund is in cancelled state, not finalized, so the function must check `cancelled` as an additional eligibility condition alongside `finalized`.

All three send to the immutable treasury address. The function may be called at any time; it sweeps whatever is currently eligible under the above rules. **After the 3-year deadline, this function also sweeps allocated-but-undelivered ARM — the name "unallocated" understates the post-expiry scope.**

**Commitment deadline is contract-enforced.** The contract reverts any commitment transaction submitted after the deadline timestamp. This is a hard contract-level guard, not a UI convention.

Post-finalization, all privileged functions are permanently inactive. `withdrawUnallocatedArm()` is permissionless — anyone may call it, and ARM transfers to the immutable treasury address set at deployment. No privileged role survives finalization.

### Allocation

The allocation algorithm proceeds in four sequential steps against the sale size `S`:

1. **Hop-2 reserve first.** Hop 2 receives `a2_reserved = min(d2, HOP2_RESERVE_USDC)`, up to $300,000, before hop 0 or hop 1 are allocated (the reserve is bounded by `S`).

2. **Hop-0 from the rest of the sale.** Hop 0 receives `min(d0, S − a2_reserved)`. When hop 2 fills its reserve this is up to $1.5M; any part of the reserve hop 2 leaves unused is available to hop 0.

3. **Hop-1 from what remains.** Hop 1 receives `min(d1, S − a2_reserved − a0)`. Its $0 cap keeps its demand, and therefore its allocation, at zero in practice.

4. **Hop-2 extra from what remains.** Hop 2 additionally receives `min(d2 − a2_reserved, S − a2_reserved − a0 − a1)`: capacity hop 0 and hop 1 left unused rolls back to hop 2 above its reserve. Any capacity no hop absorbs becomes unsold ARM, recoverable via `withdrawUnallocatedArm()`.

Each hop's final allocation is stored as its ceiling (`finalCeilings[h]`). Oversubscription at any hop is resolved pro-rata within that allocation, which happens only when total capped demand exceeds `S`, bounded by per-address per-hop caps (where the cap equals `participation_slots[(address, hop)] × HOP_CAP[hop]`). An address committed at multiple hops receives ARM allocation from each hop independently. See appendix for full pseudocode.

`capped_demand` — the sum of all aggregated per-address per-hop balances after caps — is the canonical demand variable used for the expansion trigger and per-hop statistics. The minimum raise is checked against capped demand and then against the allocated `totalAllocatedUsdc`. An address committed at multiple hops contributes to `capped_demand` at each hop independently.

### Rollover

Rollover is integrated into the allocation steps rather than a separate pass:

- Reserve hop 2 leaves unused is available to hop 0 (hop 0's limit is `S` less hop 2's reserved fill, not a fixed $1.5M)
- Hop-0 and hop-1 leftover is available to hop 2's demand above its reserve
- Capacity no hop absorbs (total capped demand below `S`) becomes unsold ARM, recoverable via `withdrawUnallocatedArm()`

Total allocation is therefore always `min(capped demand, S)`: no capacity goes unsold while any hop has unmet capped demand.

### Elastic Expansion

The crowdfund expands if `capped_demand` reaches or exceeds the expansion trigger.

```python
if capped_demand >= EXPANSION_TRIGGER:  # $1.8M USDC capped demand
    sale_size = MAX_SALE  # 1,800,000 ARM
else:
    sale_size = BASE_SALE  # 1,800,000 ARM
```

`BASE_SALE == MAX_SALE`, so the branch selects the same $1.8M either way and elastic expansion has no effect. The mechanism is kept in the contract unchanged. Oversubscribed hops are allocated pro-rata up to their final allocation; the difference between a participant's commitment and their allocation is refunded.

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

**Authority:** Security Council (2-of-3 multisig — see GOVERNANCE.md)

**Process:**
1. Security Council invokes `cancel()` — takes effect immediately
2. Contract enters refund-only mode: all committed USDC becomes withdrawable by participants via `claimRefund()`. No further privileged action required — participants pull their own refunds.

**`cancel()` sets a permanent cancelled state.** After `cancel()` is invoked: `finalize()` permanently reverts (the cancelled flag is checked at entry); `commit()` permanently reverts — no new USDC may be deposited; participants may call `claimRefund()` to withdraw their full deposited USDC; and all preloaded ARM becomes immediately sweepable to the immutable treasury address via `withdrawUnallocatedArm()`. The cancelled state is irreversible.

**Constraints:**
- Only callable before `finalize()` has been executed
- Once finalized, `cancel()` permanently reverts — no post-finalization admin leverage
- Refund mode is automatic and unconditional; the Security Council has no discretion over individual refunds

**Rationale:** Cancel takes effect immediately because a genuine emergency (active exploit, regulatory injunction) requires speed — a delay serves the attacker, not participants. Abuse protection comes from Security Council composition (not purely team-controlled), automatic unconditional refunds (no discretion over destination), and the pre-finalization-only restriction. The on-chain transaction is public the moment it is submitted.

---

## Governance

Crowdfund tokens are not revenue-gated. Voting power becomes active once ARM is claimed and delegated — unclaimed ARM is vote-inert. Early network tokens gain voting power proportional to revenue-milestone unlocks — at $0 protocol revenue, only crowdfund participants who have claimed and delegated vote.

ARM must be delegated to vote. Delegation is designated at claim time as a mandatory parameter. The Security Council can cancel the crowdfund pre-finalization in an emergency — see §Emergency Cancel.

Standard proposals take approximately 12 days (48h delay + 7d vote + 3d execution). High-impact proposals (fee changes, treasury >5%, governance parameters, steward elections) take approximately 18 days (48h + 14d + 7d). Bond: 1,000 ARM (activates after global transfer unlock — before that, governance operates on proposal threshold only). Proposal threshold: 5,000 ARM.

Crowdfund tokens become transferable via governance proposal (Extended). There are no predeclared conditions — holders decide when.

Early network tokens cannot be unlocked by governance. They unlock only via revenue milestones.

Treasury tokens (65–78%, including unsold crowdfund ARM swept after finalization) are controlled by governance but do not vote.

See GOVERNANCE.md for full specification: voting mechanics, delegation, quorum, proposal lifecycle, Treasury Steward, Security Council, and wind-down.

---

## Invite Graph Visibility

The full invite graph is public throughout the crowdfund — inviter, invitee, and hop level are visible from the moment an invite is issued. There is no post-finalization reveal step.

Participants are joining a trust network, and that network's shape should be legible to everyone in it. Full visibility during the crowdfund also reinforces the governance bootstrapping framing: you can see who you're building the network with before committing.

**App presentation.** The committer app shows a simplified graph: the hop-1 team inviter wallets are an implementation detail of issuing invite links (a link places the redeemer one hop below the signer), so the app omits them and shows the contributors they invite as invited by Armada, the same as direct launch-team placements. A disclosure in the app's Details view says so. The full graph, including the team wallets, is on-chain and visible on any block explorer; the admin app shows it too.

---

## Wind-Down

### Automatic wind-down

The protocol triggers an automatic wind-down if the revenue threshold is not reached by the deadline. Both parameters are governable with the following defaults:

| Parameter | Default | Governable |
|---|---|---|
| Revenue threshold | $10,000 cumulative | Yes (standard proposal) |
| Deadline | December 31, 2027 | Yes (standard proposal) |

The intent is to give the protocol approximately 6 months after the **shielded pool launch** to demonstrate traction. Protocol revenue only accrues through the shielded pool's fee module, which launches separately after the crowdfund, on a date not yet known. The deadline is fixed when the wind-down contract is deployed with the crowdfund, so December 31, 2027 is a deliberately conservative initial value. Once the shielded pool launch date is known, governance is expected to set the deadline to roughly 6 months after it; if the shielded pool launch slips, governance should extend the deadline before it becomes binding.

The trade-off of a conservative initial deadline: if the shielded pool is delayed or never ships, participants wait longer before the permissionless wind-down becomes available. Governance can still trigger wind-down at any time via extended proposal (see GOVERNANCE.md §Wind-Down).

If cumulative protocol revenue does not reach the threshold by the deadline, wind-down initiates automatically — no governance vote required. Governance may adjust either parameter before the deadline, or vote to wind down early at any time.

### Wind-down sequence

1. Wind-down triggers (automatic, governance vote, or the launch-team guardian; GOVERNANCE.md §Wind-Down). `triggerWindDown()` is permissionless — anyone can call it when conditions are met.
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

- **Launch-team selection quality is the critical dependency.** The allocation mechanism is algorithmic, but the network's governance quality depends entirely on who the launch team places at hop 0, which team wallet it places at hop 1, and who receives its links. This selection is the primary defence against governance concentration and Sybil attacks — the contract mechanism does not substitute for it. Maximum single-address capture is $300k (16.7% of the sale: $100k at hop 0 plus 20 stacked $10k hop-2 slots). See Self-Filling section.
- **The $10k tier is guaranteed only its $300k reserve in aggregate.** Hop 2 is served first up to $300,000, but the known tier can take the remaining $1.5M. If hop-2 demand exceeds $300,000 while known-tier demand reaches $1.5M (fifteen known contributors at their full $100k), every hop-2 contributor, including every outside contributor sent a link, is pro-rated down to a share of the $300,000 and refunded the rest. Published terms and the wording shown to link recipients should say this plainly.
- **A single tier can meet the minimum raise.** Three known contributors at their full cap ($300k), or 25 hop-2 slots at $10k, clear the $250,000 minimum. There is no tier-mix requirement for success.
- **The launch team is paid first.** A successful sale pays $250,000 to the launch team before the treasury receives anything; at the $250,000 minimum the treasury receives no USDC from the sale. The payment is fixed in the contract and visible on-chain (`LaunchTeamPaid`).
- **A launch-team address that cannot receive USDC blocks a successful finalize.** The team payment and the treasury transfer happen inside `finalize()`, so if the transfer to `launchTeam` reverts (for example, the address is blocked by the USDC issuer), `finalize()` reverts too and the sale cannot settle as a success. No funds are lost: the security council can still `cancel()`, and every participant then claims a full refund.
- **Early governance proposals may pass on thin quorum.** Voting power activates immediately upon claim and delegation with no averaging period. The first proposals after the 10-day quiet period may be created when only a small fraction of participants have claimed. Participants are strongly encouraged to claim and delegate promptly after finalization.
- **Governance capture is possible.** Whitelist is the mitigation, not a guarantee.
- **Propagation may fail.** Unused supply flows to treasury.
- **This is a trusted-network crowdfund.** Not designed for viral distribution.
- **Tokens are non-transferable at launch by design.** Transferability prioritizes governance participation during the formative phase. Token transfers can be unlocked by governance proposal.
- **Automatic wind-down is a real risk.** If the protocol does not reach $10k revenue by the wind-down deadline (initially December 31, 2027; governable), wind-down becomes permissionlessly triggerable. Revenue is zero until the shielded pool launches.
- **Slot counting is an implementation dependency.** The allocation math — cap scaling, `hopDemand`, `computeAllocation()` — reads `slotCount[address][hop]` (`invitesReceived`), a counter that increments with each invite received. It reaches up to 20 at hop 2 (the hop-2 stacking cap) and is always 0 or 1 at hop 0 and hop 1.
- **Wind-down / ARM token integration is an audit hotspot.** Wind-down assumes it can call `setTransferable(true)`, sweep non-ARM assets, exclude four hardcoded addresses from the redemption denominator, and end governance permanently. These hooks between the wind-down contract, ARM token, governor, and redemption contract are load-bearing — if any are slightly off, the wind-down integration story weakens. Priority audit target.

---

## Summary of Design Decisions

| Decision | Resolution | Rationale |
|---|---|---|
| Treasury voting | Treasury does not vote | Avoids control ambiguity |
| Early network voting | Revenue-gated | Only people who paid decide until protocol proves itself |
| Steward voting eligibility | Voting-eligible ARM only | Treasury decisions by economic stakeholders |
| Invite graph | Fully public throughout the crowdfund | No post-finalization reveal step. Participants are joining a trust network — its shape should be legible from the start. Simplifies implementation; reinforces governance bootstrapping framing over token allocation framing |
| Enactment delay | 3 days standard; 7 days extended | Short delay is honest — without locking, market prices outcomes during voting anyway. Extended delay gives Security Council a meaningful veto window on high-impact proposals. |
| Elastic expansion | None: `BASE_SALE == MAX_SALE == ELASTIC_TRIGGER` = 1.8M ARM | A single fixed sale size; the expansion branch remains in the contract but selects the same size |
| Early network allocation control | Shared RevenueLock with immutable initial entries and a capped reserve distributor; fixed 2-of-3 Safe assigns irrevocable reserve grants | Recipients govern independently; sponsored reserve payouts preserve delegation and may increase future quorum without changing existing proposals. Unassigned wind-down entitlement belongs to the allocator. |
| Pre-crowdfund distribution | Early network allocation distributed before the crowdfund opens | Full transparency for funders |
| Recurring payments | Not supported in v1 | Steward submits monthly batches instead |
| Hop allocation model | Hop-2 reserve first, then hop 0 up to the rest of the sale, with rollover both ways | Invited contributors get first claim on $300k; the known tier can take everything else. Unused reserve goes to the known tier and unused known-tier capacity goes back to hop 2, so nothing goes unsold while any hop has unmet demand |
| Hop-2 reserve | $300,000 (`HOP2_RESERVE_USDC`), first priority | Guarantees invited contributors a meaningful aggregate share without capping the known tier when hop 2 does not use it |
| Launch team payment | $250,000 (`TEAM_PAYMENT_USDC`) to the immutable `launchTeam` address on a successful finalize; the rest of the proceeds to treasury | Fixed in the contract and no larger than the minimum raise, so every successful sale covers it. No payment on refund mode or cancel |
| Multi-hop commits from single address | Permitted; receives ARM allocation at each hop independently | One slot at hop 0 and up to 20 at hop 2, so $300k per address (16.7% of the sale). Concentration through multiple wallets is legible in the graph, not preventable. |
| Stacking | `maxInvitesReceived` = 1 at hop 0 and hop 1, 20 at hop 2 | Each hop-2 invite to the same address adds a $10k slot (up to $200k); hop-0 and hop-1 nodes hold one cap and a second invite reverts |
| Invite window | Launch team and the team wallet: the whole commitment window | Launch-team discretion stays open for the full sale, so the team can respond to live subscription data until the commitment deadline; there is no final period in which launch-team actions are frozen. All launch-team actions are public on-chain. |
| Rolling hop-0 additions | Launch team may add hop-0 participants during the window, up to the 500-participant cap | Participants added late have little of the window left to commit. Hop-0 participants cannot invite. |
| Hop-0 cap | 500 hop-0 participants maximum (`uint16`) | With the launch-team and invite budgets, bounds the network to 1,101 nodes, below the 1,800-node `MAX_FINALIZE_NODES` cap; distinct individuals may be fewer under single-address multi-hop. |
| Launch team invite budgets | 1 hop-1 team wallet (100 invite slots) + 500 hop-2 placements, predeclared, during the window only | The team wallet brings outside contributors in through invite links; direct hop-2 placements cover contributors the team already knows. |
| Rollover | Unconditional — unused reserve rolls to hop 0, unused hop-0/hop-1 capacity rolls to hop 2 | Rollover thresholds dropped as weak sybil protection; hop-0 selection is the real defence. Simpler contract. |
| No commitment withdrawals | Commitments are final once submitted | Eliminates gaming risk and simplifies contract; the maximum lock period (`MAX_WINDOW_DURATION`, including any launch-team extension) is known upfront |
| Bounded window extension | Launch team may extend the deadline while the window is open, only later, up to `MAX_WINDOW_DURATION` from open | Lets an undersubscribed sale keep filling instead of cancelling and redeploying. The hard cap bounds participants' lock-up; extensions are public on-chain (`WindowExtended`) and impossible once the deadline has passed |
| Extension steps | +5 days per extension, at most two (15 days total): an operational rule; the contract enforces only the `MAX_WINDOW_DURATION` cap | The guarantee participants rely on is the maximum lock-up of their USDC, and the 15-day cap enforces it on-chain; the step size and count do not change that worst case. Enforcing the steps on-chain would add an extension counter and step checks to `extendWindow` (more code and state in the sale contract) for no extra participant protection. Every extension is public (`WindowExtended`) and recorded in the decision log, so a departure from the rule is visible. Trade-off: participants trust the launch-team Safe to follow the step rule (a single +10-day extension, say, is possible), but never beyond the 15-day cap |
| ARM pre-load requirement | 1,800,000 ARM (MAX_SALE) loaded before window opens | Ensures claim records written at finalization are always backed by sufficient ARM; enforced by contract flag |
| Settlement model | Lazy settlement: aggregate finalization + per-user computation at claim time | `finalize()` writes only aggregate state (sale size, ceilings, hopDemand, totalAllocatedArm) — zero per-participant storage writes. `claim()` computes each participant's allocation on-the-fly from aggregate parameters + their own commitment records. Net proceeds push to the launch team (team payment) and treasury at finalization. ARM and refunds pull at claim time. |
| Crowdfund finalization | Permissionless — callable by anyone after deadline | All post-deadline outcomes flow through `finalize()`. Sub-minimum demand results in `refundMode = true`. No separate deadline fallback path. Someone must call `finalize()` even in obvious failure cases (permissionless, low-cost). |
| Crowdfund emergency cancel | Security Council (2-of-3 multisig), immediate effect, pre-finalization only | Speed serves participants in a genuine emergency. Abuse protection from Security Council composition, automatic unconditional refunds, and pre-finalization-only restriction — not a delay. |
| Post-finalization | No privileged roles | All privileged functions permanently inactive after finalization. `withdrawUnallocatedArm` is permissionless — anyone calls it, ARM goes to immutable treasury address. |
| Governance quiet period | 10 days after finalization; no proposals until day 11 | Gives community time to claim, delegate, and orient. Security Council handles any emergency during this window. Constructor parameter — applies once, no effect after expiry. |
| ARM claim deadline | 3 years from finalization, fixed | Predeclared term of participation, ungovernable by design |
| Automatic wind-down | Revenue threshold + deadline, both governable | Removes need for governance vote to initiate failure-case wind-down; defaults ($10k by Dec 31 2027) are conservative enough to signal genuine traction |

---

## Contract Interface

### External Functions

| Function | Caller | Parameters | Preconditions | Effects |
|---|---|---|---|---|
| `loadArm()` | Anyone (once) | — | Contract holds ≥ MAX_SALE ARM; not already called | Sets ARM-loaded flag; arms the sale (commitment window opens at configured `openTimestamp`, not at the moment `loadArm()` is called); emits `ArmLoaded` |
| `addSeed(address)` | Launch team | Hop-0 address | ARM loaded; during the launch-team window (strictly before `launchTeamInviteEnd`); hop-0 count < 500; address not already hop-0; not cancelled; not finalized | Adds address as hop-0 node with `invitedBy = address(0)` (the canonical ROOT marker); emits `SeedAdded(seed)`; decrements hop-0 budget. The inviter is implicit — `addSeed` is callable only by the launch team sentinel, so off-chain reconstruction tools should treat every `SeedAdded` event as a ROOT edge. |
| `launchTeamInvite(invitee, fromHop)` | Launch team | Target address, inviter's hop (0 or 1; invitee joins at `fromHop + 1`) | ARM loaded; during the launch-team window (strictly before `launchTeamInviteEnd`); budget remaining for target hop (1 hop-1, 500 hop-2); invitee below that hop's stacking cap (1 at hop 1, 20 at hop 2); not cancelled; not finalized | Records invite edge from ROOT to invitee at `fromHop + 1` (a new node, or one more slot on an existing hop-2 node); emits `Invited(ROOT, invitee, fromHop + 1, 0)`; decrements launch team budget |
| `extendWindow(newEnd)` | Launch team | New deadline timestamp | Not cancelled; not finalized; `block.timestamp <= windowEnd`; `newEnd > windowEnd`; `newEnd <= windowStart + MAX_WINDOW_DURATION` | Sets `windowEnd` and `launchTeamInviteEnd` to `newEnd`; emits `WindowExtended(previousEnd, newEnd)` |
| `commit(hop, amount)` | Participant | Hop level, USDC amount | ARM loaded; pre-deadline; not cancelled; not finalized; `amount >= MIN_COMMIT` (100 USDC); address holds at least one participation slot at this hop (hop-0 slots from `SeedAdded`; hop-1/hop-2 slots from `Invited`) | Records commitment; transfers USDC to escrow; emits `Committed` |
| `invite(invitee, fromHop)` | Inviter | Target address, inviter's hop | ARM loaded; pre-deadline; not cancelled; not finalized; caller has available slots at `fromHop` | Records invite edge; creates a participation slot for invitee at `fromHop + 1` (stacking onto an existing node up to that hop's `maxInvitesReceived`, and reverting at the cap); emits `Invited(caller, invitee, fromHop + 1, 0)`; decrements inviter's slot count at `fromHop` |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | Invitee | Inviter address, inviter's hop, nonce, deadline, EIP-712 signature, USDC amount | Valid EIP-712 + EIP-1271 signature; `nonce > 0`; `amount >= MIN_COMMIT` (100 USDC); `block.timestamp ≤ deadline`; nonce not used/revoked; inviter has available slots at `fromHop`; ARM loaded; pre-deadline; not cancelled; not finalized; USDC approved | Records invite edge + commitment atomically; creates a participation slot for invitee at `fromHop + 1` (stacking onto an existing node up to the cap); transfers USDC to escrow; emits `Invited(inviter, caller, fromHop + 1, nonce)` + `Committed(caller, fromHop + 1, amount)`; consumes nonce; decrements inviter's slot count |
| `revokeInviteNonce(nonce)` | Inviter | Nonce to revoke | `nonce > 0`; nonce not already consumed or revoked | Marks nonce permanently revoked; emits `InviteNonceRevoked` |
| `finalize()` | Anyone | — | Post-deadline; not finalized; not cancelled | Iterates all participants once to compute `hopDemand[]`. Writes aggregate state only: `finalized`, `finalizationTimestamp`, `saleSize`, `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`, `totalArmTransferred = 0`. If `totalAllocatedUsdc >= MINIMUM_RAISE`: holds back the rounding buffer (only if a hop is pro-rated), transfers `min(TEAM_PAYMENT_USDC, distributable)` to `launchTeam` and the rest to treasury, emits `LaunchTeamPaid` and `Finalized(refundMode=false)`. If `totalAllocatedUsdc < MINIMUM_RAISE`: sets `refundMode = true`, no team payment or treasury transfer, emits `Finalized(refundMode=true)`. Zero per-participant storage writes. |
| `claimRefund()` | Participant | — | `refundMode == true` OR `cancelled == true`; refund not already claimed | Transfers refund USDC to caller; emits `RefundClaimed` |
| `claim(delegate)` | Participant | Delegate address | `finalized == true`; `refundMode == false`; not already claimed | Computes allocation on-the-fly via `computeAllocation(msg.sender)`. Sets `claimed[msg.sender] = true`. If within 3-year window: transfers ARM, calls `delegateOnBehalf`, increments `totalArmTransferred`. Always transfers refund USDC if any. Emits `Allocated(participant, armTransferred, refundUsdc, delegate)` + `AllocatedHop` per hop. `nonReentrant`. |
| `computeAllocation(address)` | Anyone (view) | Participant address | `finalized == true`; `refundMode == false` | Pure view function — returns `(armAmount, refundUsdc)` for the given address. Canonical computation: same logic as `claim()` minus side effects. Required for UI display of allocations before claiming. |
| `cancel()` | Security Council | — | Not finalized | Sets `cancelled` permanently; emits `Cancelled` |
| `withdrawUnallocatedArm()` | Anyone | — | `finalized == true` and within 3yr (sweeps ARM not allocated — unsold only) OR `finalized == true` and past 3yr (sweeps ARM not delivered — unsold + unclaimed + forfeited) OR `cancelled == true` (sweeps all preloaded ARM) | Transfers eligible ARM to immutable treasury address. Time check determines sweep formula. |

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
| `Finalized` | `finalize()` | `uint256 saleSize, uint256 totalAllocatedArm, uint256 netProceeds, bool refundMode` | Settlement aggregates computed; `refundMode` flag distinguishes success from refundMode finalization without reading contract storage. `netProceeds` is the total allocated USDC, before the team payment and rounding buffer |
| `LaunchTeamPaid` | `finalize()` (success path only) | `address indexed recipient, uint256 amount` | Team payment sent to the immutable `launchTeam` address: `TEAM_PAYMENT_USDC` ($250,000), bounded by the distributable proceeds. The treasury receives the rest |
| `Allocated` | `claim()` | `address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate` | Per-address settlement. Emitted at claim time, one event per claiming address. `armTransferred` is actual ARM sent (0 if claimed after 3-year expiry). `refundUsdc` is actual USDC refund sent. `delegate` is the delegation target (address(0) if no ARM transferred). Success path only (not refundMode). |
| `AllocatedHop` | `claim()` | `address indexed participant, uint8 indexed hop, uint256 acceptedUsdc` | Per-hop accepted USDC (theoretical, USDC domain — not affected by ARM expiry, since expiry affects transfer timing, not sale participation). One event per (address, hop) with `acceptedUsdc > 0`. Success path only. |
| `RefundClaimed` | `claimRefund()` | `address participant, uint256 usdcAmount` | Refund USDC transferred (refundMode / cancel / pre-finalization paths only) |
| `Cancelled` | `cancel()` | — | Crowdfund permanently cancelled by Security Council |
| `WindowExtended` | `extendWindow()` | `uint256 previousEnd, uint256 newEnd` | Commitment deadline (and launch-team deadline) moved from `previousEnd` to `newEnd`. Off-chain tools that cache `windowEnd` must refresh on this event |

**Event design principles:**
- Every state change emits an event. The observer reconstructs **committed state and claimed state** from events alone — `Committed`, `Invited`, `Finalized`, `Allocated`, `AllocatedHop`, `RefundClaimed`, and `Cancelled` events are sufficient for the core display.
- **Theoretical allocations before claims** require the `computeAllocation()` view function — they cannot be derived from events alone because the allocation math depends on aggregate parameters (`ceilings[]`, `hopDemand[]`) that are only stored on-chain, not emitted in event fields. The observer can call `computeAllocation(address)` for any participant after `Finalized` is emitted. **Events alone are insufficient to derive pre-claim allocations; the observer must query on-chain finalized aggregate state through `computeAllocation()`.**
- `Allocated` and `AllocatedHop` are emitted at `claim()` time on the success path only — one set of events per claiming participant. In refundMode, neither is emitted — the observer derives full-refund eligibility from `Finalized(refundMode=true)` combined with `Committed` totals.
- `Allocated.armTransferred` reports actual ARM sent, not theoretical entitlement. After 3-year expiry, `armTransferred` is 0 and `delegate` is `address(0)`, while `AllocatedHop.acceptedUsdc` still reflects the theoretical sale participation.
- `AllocatedHop` is only emitted when `acceptedUsdc > 0`. Zero-acceptance hops produce no event — the UI infers zero from absence.
- `commitWithInvite()` emits both `Invited` and `Committed` in the same transaction; the observer processes them independently.

### Gas Considerations

**Lazy settlement architecture.** `finalize()` writes only aggregate state — zero per-participant storage. Per-participant allocation computation and storage writes happen at `claim()` time, paid by each claimant. This eliminates the gas scaling problem that made eager per-participant finalization infeasible at ~800 participants.

**`finalize()` gas profile (cold-storage, measured):**
- Iterates every whitelisted node once to compute `hopDemand[]`. On-chain `finalize()` is its own transaction, so every node's storage is cold on first touch — **~8,200 gas/node** (2–3 cold SLOADs each). Invited-but-uncommitted nodes still cost ~4,950 gas each (2 cold SLOADs before the skip), so gas scales with **whitelist** count, not commit count.
- **A single transaction is capped at 16,777,216 gas (2^24, EIP-7825).** The node budgets bound the tree at 1,101 nodes (500 hop-0 + 1 team wallet + 100 team-wallet invites + 500 launch-team hop-2; hop-2 stacking adds slots, not nodes). One-shot cold `finalize()` at that maximum on the success path measures **~9.41M gas**, under the cap (guarded by `test-foundry/CrowdfundFinalizeGasCold.t.sol` and the real-receipt dry run `scripts/crowdfund_gas_dryrun.ts`). The separate 1,800-node `MAX_FINALIZE_NODES` cap is a backstop that the budgets never reach; the block gas limit (~30M+) is not the binding constraint — the per-tx cap is.
- **`addSeeds` batches.** All 500 hop-0 additions in a single `addSeeds` call exceed the per-tx cap; the Safe launch tooling batches at most 180 per transaction (see docs/safe-launch-batches.md).
- Aggregate SSTOREs (hopDemand, ceilings, saleSize, finalized, timestamp, totalAllocatedArm, totalArmTransferred): ~10 SSTOREs = ~200k gas
- USDC transfers to the launch team (team payment) and treasury: ~65k gas each
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

**Lazy settlement note:** This pseudocode describes the allocation *algorithm* — the math that determines who gets what. Under lazy settlement, this computation is split across two contract functions: `finalize()` executes the hop-level allocation pass (steps 1-6 below, without the per-participant loops) and stores the resulting aggregate parameters (`saleSize`, final per-hop `ceilings[]`, `hopDemand[]`, `totalAllocatedArm`). `computeAllocation(address)` executes the per-participant allocation (step 4 equivalent) at claim time, using the stored aggregates plus the participant's own commitment records. The pseudocode below shows both passes as a single function for clarity.

**Two clean asset invariants the implementation must satisfy** (see also §Conservation invariants for the lazy settlement formulation):
- **USDC:** `teamPayment + treasuryProceeds + contractDust + sum(refundUsdc[p] for all p) == totalCommitted` — all deposited USDC is either paid to the launch team, sent to treasury, returned to participants, or (only when a hop is pro-rated) left in the contract as rounding dust bounded by the `participantNodes.length` buffer. This is a settlement-completion identity that holds once all participants have claimed.
- **ARM:** `totalArmTransferred + sweepableArm == preloaded ARM` — all pre-loaded ARM is either delivered to participants or sweepable to treasury. Standing invariant: `totalArmTransferred <= totalAllocatedArm <= 1,800,000` at all times after finalization.

**Contract preconditions (enforced before `finalize()` is called):**
- An address may commit at multiple hop levels and receives ARM allocation from each independently.
- Per-address cap at any hop = `participation_slots[(address, hop)] × HOP_CAP[hop]`. Slot sources: hop-0 from `SeedAdded`; hop-1/hop-2 from `Invited` events.
- `loadArm()` has been called; contract holds ≥ `MAX_SALE` ARM.
- The commitment deadline has passed.
- If capped demand, or (after computing allocations) `totalAllocatedUsdc`, is below `MINIMUM_RAISE`, the contract sets both `finalized = true` and `refundMode = true` without reverting — `finalized = true` permanently disables `finalize()` and `cancel()`; `claimRefund()` activates via the `refundMode` condition. Under the current constants allocation equals `min(capped demand, sale size)`, so only the capped-demand check can trigger.

```python
# Constants
TOTAL_SUPPLY      = 12_000_000
BASE_SALE         = 1_800_000       # ARM (= USDC at $1/ARM)
MAX_SALE          = 1_800_000       # ARM (equal to BASE_SALE: no expansion)
MINIMUM_RAISE     =   250_000       # USDC — checked against capped demand, then totalAllocatedUsdc
EXPANSION_TRIGGER = 1_800_000       # USDC capped demand threshold
HOP2_RESERVE      =   300_000       # USDC — hop-2's first-priority capacity
TEAM_PAYMENT      =   250_000       # USDC — paid to launchTeam on a successful finalize (<= MINIMUM_RAISE)
PRICE             = 1               # Specification uses whole-unit amounts for clarity.
# Integer implementation: 1 whole ARM = 1e18 ARM units; 1 USDC = 1e6 USDC units.
# Price ratio: 1e6 USDC units per 1e18 ARM units (i.e. 1e-12 USDC units per ARM unit).
# All token amounts in the contract must use smallest units; this pseudocode uses
# whole units throughout for readability. Do not read PRICE = 1 as a unit conversion.

HOP_CAP         = {0: 100_000, 1: 0, 2: 10_000}  # USDC per slot per hop
# Per-address cap at a given hop = participation_slots[(address, hop)] × HOP_CAP[hop]
# Slot sources by hop:
#   hop-0: count of SeedAdded events where seed=address (always 0 or 1)
#   hop-1/hop-2: count of Invited events where invitee=address and invitee_hop=hop
#   (maxInvitesReceived = 1 at hop 0 and hop 1, 20 at hop 2)


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

    def participants(hop):
        # All addresses committed at this hop, regardless of other hops they joined.
        return {addr: amt for (addr, h), amt in aggregated.items() if h == hop}

    p0, p1, p2 = participants(0), participants(1), participants(2)
    d0, d1, d2 = sum(p0.values()), sum(p1.values()), sum(p2.values())

    # Step 3: Hop-2 reserve first (never more than the sale).
    reserve     = min(HOP2_RESERVE, sale_size)
    a2_reserved = min(d2, reserve)
    remaining   = sale_size - a2_reserved

    # Step 4: Hop-0 from the rest of the sale (its earmark plus any unused reserve).
    a0 = min(d0, remaining)
    remaining -= a0

    # Step 5: Hop-1 from what remains (its $0 cap keeps d1 at 0 in practice).
    a1 = min(d1, remaining)
    remaining -= a1

    # Step 6: Hop-2 extra from what hop-0 and hop-1 left unused.
    a2 = a2_reserved + min(d2 - a2_reserved, remaining)

    # ceilings[h] = final per-hop allocation (finalCeilings in the contract); hopDemand[h] = d_h.
    # A hop is pro-rated only if its demand exceeds its allocation, which requires
    # total capped demand > sale_size.
    ceilings = {0: a0, 1: a1, 2: a2}
    demands  = {0: d0, 1: d1, 2: d2}

    allocations = {}      # address -> total ARM allocated (accumulated across all hops)
    hop_allocations = {}  # (address, hop) -> ARM allocated at this specific hop (for AllocatedHop events)

    for hop, members in ((0, p0), (1, p1), (2, p2)):
        for addr, amt in members.items():
            if demands[hop] <= ceilings[hop]:
                arm = amt // PRICE
            else:
                arm = amt * ceilings[hop] // demands[hop] // PRICE  # floor round
            allocations[addr] = allocations.get(addr, 0) + arm
            hop_allocations[(addr, hop)] = arm

    # Step 7: Compute USDC and ARM accounting.
    #
    # USDC accounting:
    #   net_proceeds  = USDC actually sold = ARM allocated × PRICE (NOT a0+a1+a2,
    #                   which overcounts dust from floor rounding)
    #   team_payment  = min(TEAM_PAYMENT, net_proceeds) → pushed to launchTeam at finalization
    #   treasury_proceeds = net_proceeds - team_payment → pushed to treasury at finalization
    #   refunds       = deposited USDC not allocated → claimable via claim()
    #   invariant:    team_payment + treasury_proceeds + sum(refunds) == sum(total_deposited)
    #
    # ARM accounting:
    #   allocated_arm = ARM owed to participants → claimable via claim() (= totalAllocatedArm in lazy settlement)
    #   unsold_arm    = ARM never allocated → sweepable via withdrawUnallocatedArm() immediately
    #   invariant:    allocated_arm + unsold_arm == MAX_SALE
    #   (After 3yr, sweep formula changes to preloaded - totalArmTransferred — see §withdrawUnallocatedArm)

    allocated_arm = sum(allocations.values())                  # ARM
    net_proceeds  = allocated_arm * PRICE                      # USDC (floor-rounding dust stays in contract as unsold_arm)
    unsold_arm    = MAX_SALE - allocated_arm                   # ARM — always uses MAX_SALE, not sale_size
    # MAX_SALE ARM is preloaded; any ARM preloaded beyond it is also immediately sweepable.

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

    # Payout split (success path only). The contract computes this from totalAllocatedUsdc,
    # first holding back a rounding buffer of len(participantNodes) USDC units when any hop is
    # pro-rated (none otherwise), then paying the team from what remains.
    team_payment      = min(TEAM_PAYMENT, net_proceeds)
    treasury_proceeds = net_proceeds - team_payment

    total_deposited = {}
    for c in commitments:
        total_deposited[c.address] = total_deposited.get(c.address, 0) + c.usdc_committed

    refunds = {}
    for addr, deposited in total_deposited.items():
        allocated_usdc = allocations.get(addr, 0) * PRICE
        refunds[addr] = deposited - allocated_usdc  # always >= 0

    # Verify invariants (implementation must enforce these):
    # Under lazy settlement, these are verified as:
    #   USDC: teamPayment + treasuryProceeds + contractDust + sum(refundUsdc[p]) == totalCommitted
    #         (settlement-completion identity; contractDust <= the rounding buffer)
    #   ARM:  totalArmTransferred + sweepableArm == preloaded ARM (standing invariant)
    # The pseudocode below shows the algorithmic equivalents.
    assert team_payment + treasury_proceeds + sum(refunds.values()) == sum(total_deposited.values())  # USDC
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
| Hop-2 reserved capacity | Hop-2 has first claim on `min(d2, HOP2_RESERVE_USDC)` ($300,000); unused reserve is available to hop-0, and capacity hop-0 and hop-1 leave unused is available to hop-2's remaining demand |
| Team payment | On the success path, `min(TEAM_PAYMENT_USDC, distributable)` goes to `launchTeam` and the rest of the distributable proceeds to treasury; no payment in refund mode or after cancel |
| USDC conservation | `teamPayment + treasuryProceeds + contractDust + sum(refunds) == sum(total_deposited)` (settlement-completion identity — holds once all participants have claimed; `contractDust` is bounded by the rounding buffer and is 0 when no hop is pro-rated) |
| ARM conservation | `totalArmTransferred + sweepableArm == preloaded ARM` (sweepableArm = preloaded - totalArmTransferred) |
| Minimum raise | If `totalAllocatedUsdc < MINIMUM_RAISE` after aggregate computation, contract sets `refundMode = true` (no revert — state must be preserved for `claimRefund()` to work) |
| Integer rounding | All pro-rata splits floor-rounded per participant per hop; refunds round up (participant never under-refunded); dust accumulates in sweepable pool |
| Order-independence | All participant entitlements fixed at `finalize()` time; claims may occur in any order; no claim changes any other participant's entitlement |

**Asset flows post-finalization:**

| Asset | When | Mechanism |
|---|---|---|
| Team payment ($250,000 USDC) | At finalization (success path) | Push to immutable `launchTeam` address |
| Remaining net USDC proceeds | At finalization (success path) | Push to immutable treasury address (less the rounding buffer when a hop is pro-rated) |
| Allocated ARM (within 3yr) | After finalization, within 3-year window | Pull: participant calls `claim(delegate)` |
| Success-path USDC refunds | After finalization, no expiry | Pull: participant calls `claim(delegate)` — refund portion always payable |
| RefundMode/cancel USDC refunds | After finalization or cancel, no expiry | Pull: participant calls `claimRefund()` |
| Unsold ARM | After finalization | Pull: anyone calls `withdrawUnallocatedArm()` (sweeps ARM not allocated) |
| Unclaimed + forfeited ARM | After 3-year claim deadline | Pull: anyone calls `withdrawUnallocatedArm()` (sweeps ARM not delivered) |
