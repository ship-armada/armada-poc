# Armada Crowdfund UI — Interface Spec

## Purpose

The primary interface for participating in the Armada crowdfund: committing USDC, issuing invites, and claiming ARM/refunds. Embeds the observer (tree + table + stats banner) to provide full network context alongside the action interface.

Built as a standalone React app with wallet connection. The observer component is embedded directly — same tree, same table, same stats banner, rendered as a live panel alongside the action interface.

---

## Architecture

The app has two halves:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Stats Banner (full width, always visible)                         │
├──────────────────────────────────┬──────────────────────────────────┤
│                                  │                                  │
│  Observer Panel                  │  Action Panel                    │
│  (tree + table, read-only)       │  (Commit / Invite / Claim)       │
│                                  │                                  │
│  ← same component from           │  ← wallet-connected,             │
│     CROWDFUND_OBSERVER.md         │     context-aware                │
│                                  │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│  Mobile: observer and action panel are tabbed, not side-by-side     │
└─────────────────────────────────────────────────────────────────────┘
```

The observer panel is the exact component from CROWDFUND_OBSERVER.md, receiving data via props from the shared data layer. The action panel reads the same data and adds wallet-connected write operations.

**Desktop:** Side by side, resizable split. Observer takes ~60%, action panel ~40%.
**Mobile:** Tabbed — "Network" (observer) and "Participate" (action panel). Stats banner remains visible in both tabs.

---

## Wallet Connection

**Required for all actions.** The app is useful without a wallet (observer is fully functional read-only), but Commit / Invite / Claim all require a connected wallet.

**Connect flow:**
1. "Connect Wallet" button in the action panel header
2. Standard wallet modal (WalletConnect, MetaMask, Coinbase Wallet, etc. via wagmi/RainbowKit)
3. Once connected: the action panel populates with the connected address's eligibility, balances, and available actions
4. The observer highlights the connected address's node(s) in the tree and row in the table

**Wallet state displayed in action panel header:**
- Connected address (ENS-resolved if available)
- USDC balance (read from chain)
- Network indicator (correct chain check — revert if wrong network)

**Disconnect:** Always available. Returns the action panel to the "Connect Wallet" prompt. Observer continues functioning.

---

## Action Panel

Three tabs: **Commit** | **Invite** | **Claim**

The active tab is determined by context:
- During commitment window: default to Commit (or Invite if no eligible hops to commit to)
- After commitment deadline, before finalization: no actions available — show status message
- After finalization: default to Claim
- After cancel: default to Claim (refund)

Each tab shows only actions available to the connected address. Tabs with no available actions show a brief explanation of why (e.g., "No invite slots available" or "Claim available after finalization").

---

## Commit Tab

### Eligibility Check

On wallet connection, the app checks which hops the connected address is eligible for by scanning multiple event sources:
- **Hop-0:** `SeedAdded` events (address was added as a seed by the launch team)
- **Hop-1/2 via invite:** `Invited` events where the address is the invitee
- **Hop-1/2 via launch team:** `Invited` events from the ROOT sentinel (launch team direct placements)

Display:

```
Your positions:
  Hop-0     — invited by Armada        Cap: $15,000   Committed: $0
  Hop-1 (2 slots)  — invited by alice.eth ×2  Cap: $8,000    Committed: $0
  Hop-2             — invited by bob.eth       Cap: $1,000    Committed: $0
```

Caps scale with invites received: `invites_received × HOP_CAP[hop]`. An address invited twice to hop-1 has a $8,000 cap (2 × $4,000). Hop-0 participants always have 1 slot at hop-0.

If the address has no invitations: "You haven't been invited to this crowdfund yet."

If the address has already committed at some hops, show remaining capacity:

```
Your positions:
  Hop-0     — invited by Armada        Cap: $15,000   Committed: $12,000   Remaining: $3,000
  Hop-1 (2 slots)  — invited by alice.eth ×2  Cap: $8,000    Committed: $8,000    ✓ Full
  Hop-2             — invited by bob.eth       Cap: $1,000    Committed: $0        Remaining: $1,000
```

### Amount Entry

For each eligible hop with remaining capacity, show an amount input:

```
┌─ Commit to Hop-0 ──────────────────────────────────────────┐
│  Amount: [________] USDC          MAX: $3,000 remaining     │
│  Current hop demand: $987,000 (131% of $798k ceiling)       │
│  ⚠ This hop is oversubscribed — pro-rata scaling applies    │
└─────────────────────────────────────────────────────────────┘

┌─ Commit to Hop-2 ──────────────────────────────────────────┐
│  Amount: [________] USDC          MAX: $1,000 remaining     │
│  Current hop demand: $48,000 (80% of $60k floor)            │
│  Floor not yet filled — full allocation likely               │
└─────────────────────────────────────────────────────────────┘
```

**Per-hop context shown inline:**
- Current hop demand and oversubscription status (same data as stats banner, but per-hop)
- For hop-0/1: percentage of enforced ceiling, with warning if >100%
- For hop-2: floor coverage percentage, with note that >100% of floor doesn't necessarily mean pro-rata (effective ceiling grows with hop-1 leftover)
- A "MAX" button that fills the remaining capacity

**Multi-hop total:** Below all hop inputs, show the running total across all hops:
```
Total commitment: $4,000 USDC across 2 hops
Your USDC balance: $12,450
```

Warn if total exceeds USDC balance. Do not prevent submission — over-cap deposits are permitted and refunded, but insufficient balance will cause the transaction to revert.

### Pro-Rata Estimate

Below the amount inputs, before the review step, show an estimated allocation:

```
┌─ Estimated Allocation (if finalized now) ──────────────────┐
│                                                             │
│  Hop-0:  $3,000 committed → ~$2,290 allocated  (76% fill)  │
│  Hop-2:  $1,000 committed → ~$1,000 allocated  (100% fill) │
│  ─────────────────────────────────────────────────────────   │
│  Total:  $4,000 committed → ~$3,290 allocated               │
│  Est. refund: ~$710                                          │
│                                                             │
│  ⚠ Estimate only. Actual allocation depends on final demand │
│    at commitment deadline. Commitments are final and cannot  │
│    be withdrawn before the deadline.                         │
└─────────────────────────────────────────────────────────────┘
```

**Estimate calculation:** For each hop, if demand ≤ ceiling, allocation = committed amount. If demand > ceiling, allocation ≈ (committed / demand) × ceiling. This uses current on-chain demand — it will change as others commit or as the sale expands.

**Caveats (always displayed):**
- "Estimate only" — demand changes between now and deadline
- "Commitments are final" — no withdrawals before deadline
- "3-week maximum lock" — USDC is locked until finalization + refund claim

### Review and Confirm

Clicking "Review Commitment" shows a confirmation screen:

```
┌─ Confirm Commitment ───────────────────────────────────────┐
│                                                             │
│  You are committing:                                        │
│    Hop-0:  $3,000 USDC                                      │
│    Hop-2:  $1,000 USDC                                      │
│    Total:  $4,000 USDC                                      │
│                                                             │
│  This commitment is final. You cannot withdraw USDC before  │
│  the deadline (14 days remaining). After finalization:       │
│    • If the hop is oversubscribed, you receive pro-rata ARM  │
│      and a USDC refund for the difference.                   │
│    • If net proceeds fall below $1M, you receive a full      │
│      USDC refund (refundMode).                               │
│                                                             │
│  Estimated allocation (based on current demand):             │
│    ~$3,290 ARM + ~$710 USDC refund                           │
│                                                             │
│           [ Confirm & Sign ]        [ Back ]                 │
└─────────────────────────────────────────────────────────────┘
```

**Transaction handling:**
- Each hop commitment is a separate transaction (the contract's `commit(hop, amount)` function is per-hop)
- If committing to multiple hops, transactions are submitted sequentially — the UI shows progress per hop
- On success: the observer updates automatically via polling; the commitment tab refreshes with updated balances
- On failure: show the revert reason (deadline passed, cancelled, wrong hop, insufficient USDC balance)

### Post-Commitment State

After committing, the commit tab shows updated positions with a "committed" indicator and any remaining capacity. If all hops are fully committed, show:
```
All positions filled. Total committed: $20,000 across 3 hops.
You can add more to any hop with remaining capacity at any time before the deadline.
```

---

## Invite Tab

### Invite Slots

On wallet connection, show the connected address's invite capacity and outstanding links:

```
Your invites:

  From Hop-0 → Hop-1:
    Slots: 3 total · 1 redeemed · 2 available
    Outstanding links: 2 (expires in 3d, 5d)        [ Copy ]  [ Revoke ]
    [ Create Link ]  [ Invite Directly ]

  From Hop-1 → Hop-2:
    Slots: 2 total · 0 redeemed · 2 available
    Outstanding links: none
    [ Create Link ]  [ Invite Directly ]
```

**Slots track on-chain redemptions only.** A slot is consumed when an invite is successfully recorded on-chain (via direct invite or link redemption). Outstanding links are signed but not yet redeemed — they do NOT reserve slots. The UI shows both counts so the inviter understands the relationship:

```
⚠ You have 2 slots available and 3 outstanding links.
  Links are first-come-first-served. If all 3 are redeemed,
  only the first 2 will succeed.
```

If the address has no invite slots (hop-2 participant, or no invitations at all): "You don't have any invite slots."

### Two Invite Paths

**Path A: Invite Link (primary).** The inviter creates a shareable link without knowing the recipient's address. The invitee opens the link, connects their wallet, and commits in one transaction — joining the network and deploying capital atomically.

**Path B: Direct Invite (fallback).** The inviter enters the invitee's address or ENS directly. The invite is recorded on-chain immediately. The invitee can then commit separately. Use this when the inviter already knows the recipient's address.

**Key behavioral difference:** Path A (link) bundles invite redemption with the first commitment — the invitee appears in the graph only when they commit with funds. Path B (direct) records the invite immediately — the invitee appears in the graph with $0 committed and can commit later. Both produce an `Invited` event and a graph edge; Path A also produces a `Committed` event in the same transaction.

### Path A: Invite Link Flow

**Step 1 — Inviter creates link (off-chain, no gas):**

```
┌─ Create Invite Link ───────────────────────────────────────┐
│                                                             │
│  From: your Hop-0 position                                  │
│  Inviting to: Hop-1 ($4,000 cap, 2 invite slots)           │
│  Available slots: 2 of 3 remaining                           │
│                                                             │
│  This creates a one-time link. The first person to use it    │
│  joins the network at Hop-1 and commits USDC in one step.   │
│                                                             │
│  Link expires: 5 days from now                               │
│                                                             │
│  ⚠ This is a bearer link — anyone with it can use it.        │
│    Share it privately.                                        │
│                                                             │
│           [ Sign & Create Link ]                             │
└─────────────────────────────────────────────────────────────┘
```

The inviter's wallet prompts an EIP-712 typed data signature (no gas, no transaction):

```
EIP-712 typed data:

  domain: {
    name: "ArmadaCrowdfund",
    version: "1",
    chainId: <deployment chain>,
    verifyingContract: <contract address>
  }

  types: {
    Invite: [
      { name: "inviter",  type: "address" },
      { name: "fromHop",  type: "uint8"   },
      { name: "nonce",    type: "uint256"  },
      { name: "deadline", type: "uint256"  }
    ]
  }

  value: {
    inviter:  0x…,
    fromHop:  0,
    nonce:    2,
    deadline: <block.timestamp + 5 days>
  }
```

The contract MUST validate all four domain fields to prevent cross-chain and cross-contract replay.

Nonces are per-inviter, any unique `uint256 > 0` — nonce 0 is reserved as the sentinel for direct invites. The contract imposes no ordering requirement on valid nonces. Each nonce can be consumed (by successful redemption) or revoked (by the inviter) exactly once. The UI generates sequential nonces starting from 1 for simplicity, but the contract accepts any unused value > 0. The signed message is encoded into a URL:

```
https://app.armada.voyage/invite?inviter=0x…&fromHop=0&nonce=2&deadline=1753000000&sig=0x…
```

**Link expiry:** Default 5 days from creation (baked into the signed `deadline` field). The contract checks `block.timestamp <= deadline` at redemption. If a link expires unused, the inviter generates a replacement for free — just another wallet signature, no gas. Expiry is a security measure, not a participation barrier.

**Slot reservation semantics:** Signing a link does NOT reserve a slot. Slots are checked at redemption time, not at signing time. An inviter can sign more links than they have slots — only the first N redeemed (where N = available slots) will succeed. The UI communicates this clearly:

```
⚠ You have 2 slots remaining and 3 outstanding links.
  Only the first 2 redeemed will succeed. Remaining links
  will fail when the invitee tries to use them.
```

**Link management:** After creation, the link appears in the invite slots list as "pending" with an expiry countdown. The inviter can:
- **Copy link** — copies the URL to clipboard
- **Revoke** — calls `revokeInviteNonce(nonce)` on-chain. The nonce is permanently invalidated; anyone trying to redeem the link gets "This invite link has been revoked." Revocation costs gas but provides a definitive kill-switch for leaked links.

**Batch creation:** The inviter can create all available links at once ("Create all links"). Each link gets a unique nonce (the UI assigns sequentially for simplicity), the same 5-day deadline, and a separate signature. All signatures are prompted in sequence (wallet may batch-approve if supported). Links are stored in the UI — the inviter should save/copy them before leaving the page.

**Link storage:** Generated links and their signatures are stored in the browser (IndexedDB alongside the event cache). This means:
- Links persist across page reloads on the same browser
- Links are NOT recoverable from another device — the inviter must copy and save them
- The contract has no concept of "pending links" — it only sees redeemed invites

**Step 2 — Invitee commits via link (one transaction, invitee pays gas):**

The invitee opens the link and sees:

```
┌─ You've Been Invited to Armada ────────────────────────────┐
│                                                             │
│  Invited by: alice.eth (0xABC…)                             │
│  Position: Hop-1                                             │
│  Cap: $4,000 USDC                                            │
│  Invite slots: 2 (you can invite 2 people to Hop-2)         │
│  Link expires: 3 days remaining                              │
│                                                             │
│  Connect your wallet to join and commit.                     │
│                                                             │
│           [ Connect Wallet ]                                 │
└─────────────────────────────────────────────────────────────┘
```

After wallet connection, the invitee enters their commitment amount and reviews:

```
┌─ Join & Commit ────────────────────────────────────────────┐
│                                                             │
│  Your address: bob.eth (0xDEF…)                              │
│  Position: Hop-1 (invited by alice.eth)                      │
│                                                             │
│  Amount: [________] USDC          MAX: $4,000                │
│                                                             │
│  Current hop-1 demand: $342,000 (67% of ceiling)             │
│  Estimated allocation: ~$[amount] (full, hop not oversubscribed) │
│                                                             │
│  This will:                                                  │
│    • Add you to the network at Hop-1                         │
│    • Commit your USDC (final — no withdrawals before deadline) │
│    • Give you 2 invite slots to Hop-2                        │
│                                                             │
│  The invite edge (alice.eth → bob.eth) and your commitment   │
│  will be visible in the public network graph.                │
│                                                             │
│  ⚠ Commitment is final. USDC is locked until finalization.   │
│                                                             │
│           [ Join & Commit ]        [ Decline ]               │
└─────────────────────────────────────────────────────────────┘
```

**Transaction:** The invitee calls `commitWithInvite(inviter, fromHop, nonce, deadline, signature, commitAmount)` — a single transaction that:
1. Verifies the invite signature (EIP-712 + EIP-1271 via OpenZeppelin `SignatureChecker`)
2. Checks `block.timestamp <= deadline`
3. Checks the nonce hasn't been used or revoked
4. Checks the inviter has available slots at `fromHop`
5. Records the invite edge: `(inviter, fromHop) → (msg.sender, fromHop + 1)`
6. Records the commitment: `msg.sender` commits `commitAmount` USDC at `fromHop + 1`
7. Emits `Invited(inviter, msg.sender, fromHop + 1, nonce)` AND `Committed(msg.sender, fromHop + 1, commitAmount)` — the nonce in `Invited` makes link consumption observable on-chain
8. Marks the nonce as consumed, decrements inviter's slot count

USDC approval must be in place before this transaction. If the invitee has not approved, the UI shows a two-step flow: "Step 1: Approve USDC → Step 2: Join & Commit."

On success: the invitee is redirected to the main app with their new position visible in the observer, the Commit tab showing their remaining capacity at this hop, and the Invite tab showing their new invite slots.

**Failure cases:**
- Link expired (`block.timestamp > deadline`): "This invite link has expired. Ask the inviter for a new link."
- Link already used (nonce consumed): "This invite link has already been used by someone else."
- Link revoked: "This invite link has been revoked by the inviter."
- Inviter out of slots: "The inviter has no remaining invite slots." (race condition — more links created than slots)
- Deadline passed: "The commitment deadline has passed."
- Insufficient USDC: "Your USDC balance is insufficient."
- USDC not approved: "You need to approve USDC spending first."

### Front-running risk for invite link redemption

The `commitWithInvite()` transaction exposes the invite signature in calldata. Because the invite signature is a bearer credential (it does not bind to the invitee's address), a mempool observer can extract the signature from a pending transaction and submit a competing transaction with the same signature as a different `msg.sender`, stealing the invite slot.

This does not affect `invite()` (direct path — the invitee address is explicit) or `commit()` (no signature involved).

**Mitigation: private transaction submission.**

Because `commitWithInvite()` exposes a bearer invite signature in calldata, redeeming an invite link through the public mempool creates theft risk. On Ethereum mainnet, the committer app should recommend and, where supported by the connected wallet/provider, default to a private transaction path such as Flashbots Protect (`https://rpc.flashbots.net`). This reduces public-mempool front-running risk by avoiding public broadcast before inclusion. It is a trust-based mitigation, not a cryptographic guarantee: users still trust the private-orderflow provider and participating builders not to disclose or misuse transaction contents.

Use default Protect, not `/fast` mode. Default Protect forwards only to the Flashbots builder. Fast mode shares with all registered builders and TEE searchers, which is worse for a bearer credential where privacy matters more than speed.

**Implementation note:**

In typical wallet-connected flows, private submission depends on the user wallet / RPC path, not just the dapp. The easiest supported path today is a wallet configured to the Flashbots Protect RPC. Advanced app-controlled submission paths may use private transaction APIs directly, but these are separate from normal public-RPC wallet flows. If private submission is unavailable for the connected wallet or provider, the UI should show an explicit warning before the user submits `commitWithInvite()` through the public mempool.

**Why not bind the signature to the invitee?**

Including the invitee address in the EIP-712 signed message would eliminate the front-running risk but would require the inviter to know the invitee's wallet address before creating the link. This defeats the invite link model where the inviter creates a shareable link without knowing who will use it. The bearer credential design is intentional — private transaction submission is the appropriate UI-layer mitigation.

**Operational expectations for Flashbots Protect:**

- Flashbots Protect is a practical default on Ethereum mainnet. The easiest supported path today is a wallet configured to the Flashbots Protect RPC.
- Private invite-link redemption must use a nonzero priority fee. Flashbots Protect drops transactions with a priority fee of 0.
- Default Protect retries for a limited inclusion window. If the private transaction is not included and is dropped, the UI should surface a retry state rather than leaving the user in an indefinite pending state.
- If using a wallet-configured Protect RPC, the UI should warn users not to switch RPCs/providers before confirmation. Some wallets may resend the transaction to the public mempool if the RPC is changed while the transaction is still pending.
- If private submission is unavailable, the UI should warn clearly that public-mempool redemption may allow invite theft, and may recommend the direct invite path for sensitive placements.

**Fallback: nonce revocation.**

If a participant suspects their invite link has been leaked or compromised, the inviter can call `revokeInviteNonce(nonce)` to permanently invalidate the link before it is redeemed. This is an on-chain transaction (costs gas) and serves as a kill-switch.

### Path B: Direct Invite Flow

For inviters who already know the recipient's address:

```
┌─ Invite Directly to Hop-1 (from your Hop-0) ──────────────┐
│                                                             │
│  Address or ENS: [________________________]                  │
│                                                             │
│  This will invite the address to Hop-1 with a $4,000 cap    │
│  and 2 invite slots of their own.                            │
│                                                             │
│  The invite is recorded on-chain immediately and visible     │
│  in the network graph. The invitee can commit separately.    │
│                                                             │
│           [ Invite ]        [ Cancel ]                       │
└─────────────────────────────────────────────────────────────┘
```

**Validation before submission:**
- Resolve ENS to address (show resolved address for confirmation)
- Check that invite slots are available
- Warning (not a block) if inviting own address: "You are inviting yourself. This will create a self-loop in the graph — this is permitted and will be visible."

**Transaction:** `invite(invitee, fromHop)` where the inviter is `msg.sender` and `fromHop` is the inviter's hop level. The invitee joins at `fromHop + 1`. Inviter pays gas. On success, the observer updates with the new edge and node. The invite slots counter decrements. The invitee appears in the graph with $0 committed and can commit later via the Commit tab.

### Self-Invite Shortcut

If the connected address has unused invite slots, offer a one-click self-invite option:

```
Quick action: Self-invite to Hop-1
  Fill your own hop-1 position ($4,000 cap) using one of your hop-0 invite slots.
  This is visible in the graph as a self-loop.     [ Self-Invite ]
```

This uses the direct invite path (inviter pays gas, immediate on-chain recording). Displayed only when:
- The address has unused invite slots
- The address is not already at the target hop

### Duplicate Invite Handling

Multiple inviters can invite the same address to the same hop. Each invite creates a new participation slot — the invitee's effective cap at that hop equals `invites_received × HOP_CAP[hop]`, and outgoing invite slots scale proportionally. The same inviter can also invite the same address more than once (e.g., via two separate links). All edges are recorded and visible in the graph.

The UI does not block duplicate invites but shows a notice: "This address already has N slots at Hop-1. Your invite will add another slot, increasing their cap by $4,000."

---

## Claim Tab

### Pre-Finalization

Before finalization, the claim tab shows:
```
Claims are available after the crowdfund is finalized.
Current status: OPEN (14 days remaining)
```

Or, if finalization has set refundMode (sub-minimum demand):
```
The crowdfund has been finalized in refund mode — total demand ($870,000)
was below the minimum raise ($1,000,000). You may withdraw your full deposit.

  Your deposit: $19,000 USDC
  [ Claim Refund ]
```

### Post-Finalization (Success)

```
┌─ Your Settlement ──────────────────────────────────────────┐
│                                                             │
│  Committed: $19,000 USDC across 3 hops                      │
│  Allocated: 18,200 ARM                                       │
│  Refund:    $800 USDC                                        │
│                                                             │
│  Breakdown:                                                  │
│    Hop-0: $15,000 committed → 14,200 ARM (pro-rata, 95%)    │
│    Hop-1: $3,000 committed  → 3,000 ARM (full allocation)   │
│    Hop-2: $1,000 committed  → 1,000 ARM (full allocation)   │
│                                                             │
│  ARM Claim:                                                  │
│    18,200 ARM available                                      │
│    Delegation required — select delegate: [____________]     │
│    [ Claim ARM ]                                             │
│                                                             │
│  USDC Refund:                                                │
│    $800 USDC available                                       │
│    [ Claim Refund ]                                          │
│                                                             │
│  ⚠ ARM claim deadline: 3 years from finalization.            │
│    Refunds do not expire.                                    │
└─────────────────────────────────────────────────────────────┘
```

**Settlement data sources:** Under lazy settlement, the UI can display theoretical allocations immediately after `Finalized` by calling `computeAllocation(connectedAddress)` — no need to wait for events. As participants call `claim()`, `Allocated` events provide confirmed settlement data. Per-hop breakdown comes from `AllocatedHop` events (emitted at claim time). In refundMode, neither event is emitted — the claim tab shows full refund eligibility derived from `Committed` totals.

**Claim tab logic after finalization:**
- `Finalized` received → call `computeAllocation(connectedAddress)` to display theoretical allocation; enable `claim(delegate)` button
- `Allocated` event received for connected address → update display with confirmed settlement (actual `armTransferred` and `refundUsdc`)
- `Finalized(refundMode=true)` → show refund-only via `claimRefund()`
- Post-3yr expiry → `claim()` still available but ARM portion forfeited; show "Claim refund only — ARM claim period has expired"

**Delegation at claim time:** The crowdfund spec requires delegation as a mandatory parameter at claim. The claim UI must include a delegate address input. Options:
- Self-delegate (default, pre-filled with connected address)
- Enter another address or ENS
- Brief explanation: "Delegation is required to vote. You can change your delegate later."

**Claim transactions:** ARM claim and refund claim are separate transactions. Show status for each independently (claimed ✓ / unclaimed). Both can be done in either order.

### Post-Finalization (RefundMode)

```
┌─ Refund Mode ──────────────────────────────────────────────┐
│                                                             │
│  The crowdfund finalized but net proceeds ($798,000) fell    │
│  below the minimum raise ($1,000,000). All deposits are      │
│  fully refundable. No ARM was allocated.                     │
│                                                             │
│  Your deposit: $19,000 USDC                                  │
│  [ Claim Full Refund ]                                       │
└─────────────────────────────────────────────────────────────┘
```

### Post-Cancel

```
┌─ Crowdfund Cancelled ──────────────────────────────────────┐
│                                                             │
│  The crowdfund was cancelled by the Security Council.        │
│  All deposits are fully refundable. No ARM was allocated.    │
│                                                             │
│  Your deposit: $19,000 USDC                                  │
│  [ Claim Full Refund ]                                       │
└─────────────────────────────────────────────────────────────┘
```

### Post-Claim State

After claiming, show completed status:

```
  ARM Claim:     18,200 ARM claimed ✓  (delegated to self)
  USDC Refund:   $800 claimed ✓
  
  All claims complete.
```

---

## Connected Address Highlighting

When a wallet is connected, the observer panel highlights the connected address throughout:

- **Tree:** Connected address's node(s) have a distinct border or glow. Their inviter chain (path back to ROOT) is subtly highlighted.
- **Table:** Connected address's row is pinned to the top or visually distinguished (background color, border).
- **Stats banner:** Shows a small personal summary: "You: $19,000 committed across 3 hops"

This creates an immediate "you are here" orientation when the participant arrives.

---

## Transaction States

All write operations (commit, invite, claim) follow a consistent transaction flow:

```
[ Action Button ]
    ↓
"Waiting for wallet signature..."     (wallet popup open)
    ↓
"Transaction submitted. Waiting for confirmation..."     (tx hash shown, link to explorer)
    ↓
"Confirmed ✓"     (observer data refreshes automatically)
    ↓  or
"Transaction failed: {revert reason}"     (with retry option)
```

**Revert reasons mapped to human-readable messages:**

| Revert | Message |
|---|---|
| Deadline passed | "The commitment deadline has passed. No new commitments are accepted." |
| Cancelled | "This crowdfund has been cancelled. No new commitments are accepted." |
| Already finalized | "This crowdfund has already been finalized." |
| ARM not loaded | "The crowdfund has not opened yet." |
| Invalid hop | "You are not invited to this hop level." |
| Already claimed | "You have already claimed this." |
| Claim expired | "The 3-year claim deadline has passed." |
| refundMode | "No ARM allocations were recorded (refund mode). Use Claim Refund instead." |
| Insufficient balance | "Your USDC balance is insufficient for this commitment." |
| Invalid signature | "This invite link has an invalid signature." |
| Nonce consumed | "This invite link has already been used." |
| Nonce revoked | "This invite link has been revoked by the inviter." |
| No invite slots | "The inviter has no remaining invite slots at this hop." |

---

## Events Emitted (Contract Requirements)

The commitment UI consumes the following events from the `ArmadaCrowdfund` contract:

`Invited` (includes `nonce` — 0 for direct invites, > 0 for link redemptions), `Committed`, `SeedAdded`, `Finalized`, `Allocated` (per-address settlement, emitted at `claim()` time — includes `armTransferred`, `refundUsdc`, `delegate`), `AllocatedHop` (per-hop accepted USDC, emitted at `claim()` time — only emitted when `acceptedUsdc > 0`, success path only), `RefundClaimed`, `Cancelled` (shared with the observer), plus `ArmLoaded` (to distinguish pre-open from open state) and `InviteNonceRevoked` (nonce explicitly revoked by inviter). Together, `Invited.nonce` and `InviteNonceRevoked` make all invite-link lifecycle states (pending, consumed, revoked) fully observable from events. Pre-claim theoretical allocations are available via the `computeAllocation(address)` view function immediately after `Finalized`. In refundMode, neither `Allocated` nor `AllocatedHop` is emitted.

**Write functions called:**

| Function | Tab | Parameters | Notes |
|---|---|---|---|
| `commit(hop, amount)` | Commit | Hop level, USDC amount | One tx per hop. USDC approval required. For already-invited participants. |
| `invite(invitee, fromHop)` | Invite | Target address, inviter's hop (invitee joins at `fromHop + 1`) | Direct invite path (Path B). Inviter is msg.sender. Inviter pays gas. Invitee appears in graph immediately with $0 committed. |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | Invite (link) | Inviter address, inviter's hop, nonce (> 0), deadline, EIP-712 sig, USDC amount | Link-based path (Path A). Invitee is msg.sender. Invitee pays gas. Atomic: records invite edge + commitment in one tx. Signature verified via `SignatureChecker` (EOA + EIP-1271). |
| `revokeInviteNonce(nonce)` | Invite | Nonce to revoke (must be > 0) | On-chain revocation. Prevents a generated link from being redeemed. Inviter pays gas. Reverts if nonce == 0. |
| `claim(delegate)` | Claim | Delegate address | Delegation is mandatory. ARM transferred to msg.sender. |
| `claimRefund()` | Claim | — | USDC transferred to msg.sender. |

**USDC approval flow:** Before the first `commit()`, the UI must check the connected address's USDC allowance for the crowdfund contract. If insufficient, prompt for an `approve()` transaction first. Show this as a two-step flow: "Step 1: Approve USDC spending → Step 2: Commit." Offer "approve exact amount" vs. "approve unlimited" — default to exact amount for safety, with unlimited as an option for participants who plan multiple commits.

---

## Data Layer

The commitment UI shares the same data layer as the observer. Both read from the same `EventSource` and `useGraphState` hooks. The action panel adds:

```
hooks/
  useWallet.ts            // wallet connection state (wagmi)
  useEligibility.ts       // derived: which hops is connected address invited to?
  useAllowance.ts         // USDC allowance check for commit flow
  useTransactionFlow.ts   // submit tx → wait → confirm/error flow
  useProRataEstimate.ts   // live pro-rata estimate from current demand + ceilings
```

**Pro-rata estimate hook:** Computes estimated allocation per hop for a given input amount, using current demand from the observer data layer. Recalculates on every poll cycle (demand changes). Does not call the contract — it's a pure client-side calculation using the same formulas as the allocation algorithm:
```
if hop_demand <= hop_ceiling:
    estimated_allocation = input_amount
else:
    estimated_allocation = (input_amount / hop_demand) * hop_ceiling
```

This is an approximation — it doesn't account for floor rounding, multi-hop demand interactions, or changes between now and finalization. The UI labels it as an estimate explicitly.

---

## State-Dependent Tab Visibility

| Contract state | Commit tab | Invite tab | Claim tab |
|---|---|---|---|
| Pre-commitment (ARM not loaded) | Disabled: "Not yet open" | Disabled: "Not yet open" | Disabled: "Not yet open" |
| Commitment window open | Active | Active (if address has invite slots) | Disabled: "Available after finalization" |
| Deadline passed, not finalized, capped_demand ≥ MIN | Disabled: "Deadline passed" | Disabled: "Deadline passed" | Disabled: "Awaiting finalization" |
| Deadline passed, not finalized, capped_demand < MIN | Disabled: "Deadline passed" | Disabled: "Deadline passed" | Active: refund available |
| Finalized (success) | Disabled: "Finalized" | Disabled: "Finalized" | Active: ARM claim + refund |
| Finalized (refundMode) | Disabled: "Finalized" | Disabled: "Finalized" | Active: full refund only |
| Cancelled | Disabled: "Cancelled" | Disabled: "Cancelled" | Active: full refund only |

Disabled tabs show a brief status message explaining why. They don't disappear — the participant should always see all three tabs to understand what the full lifecycle looks like.

---

## Visual Design

Inherits from armada.voyage palette and the observer's visual language. The action panel should feel like a natural complement to the observer — same dark background, same typography, same hop color coding.

**Key visual principles:**
- The observer is the context; the action panel is the action. The split should feel like reading a dashboard (left) and acting on it (right).
- Hop colors in the action panel match the observer's hop colors exactly — hop-0 accent, hop-1 secondary, hop-2 muted.
- Transaction states use clear progressive indicators (pending → submitted → confirmed), not spinners.
- Warning and error states are warm colors, consistent with the observer's oversubscription indicators.
- The connected address highlight in the observer should feel like "you are here on the map" — orientation, not decoration.

---

## Technical Architecture

Extends the observer's architecture:

```
src/
  components/
    // Observer (from CROWDFUND_OBSERVER.md):
    StatsBar.tsx
    TreeView.tsx
    TableView.tsx
    NodeDetail.tsx
    SearchBar.tsx
    // Action panel:
    ActionPanel.tsx          // tab container
    CommitTab.tsx             // eligibility + amount entry + review
    InviteTab.tsx             // invite slot management + link creation + direct invite
    InviteLinkRedemption.tsx  // landing page for invite link recipients
    ClaimTab.tsx              // ARM claim + refund claim
    ProRataEstimate.tsx       // estimate display component
    TransactionFlow.tsx       // shared tx submission UI
    WalletHeader.tsx          // connected address + balance + network
    DelegateInput.tsx         // delegate address selector for claim
  hooks/
    // Observer hooks:
    useContractEvents.ts
    useGraphState.ts
    useENS.ts
    useSelection.ts
    // Action hooks:
    useWallet.ts
    useEligibility.ts
    useAllowance.ts
    useTransactionFlow.ts
    useProRataEstimate.ts
    useInviteLinks.ts         // create, store, revoke invite links (EIP-712 + IndexedDB)
  lib/
    // Observer lib:
    events.ts
    graph.ts
    cache.ts
    rpc.ts
    constants.ts
    // Action lib:
    contracts.ts             // contract write ABI + functions
    estimate.ts              // pro-rata estimation logic
    inviteLinks.ts           // EIP-712 typed data construction, link URL encoding/decoding
  App.tsx
```

### Additional dependencies (beyond observer)

- **wagmi + @rainbow-me/rainbowkit** — wallet connection + chain management
- **viem** — contract write interactions (already a dependency for observer reads)

### Performance

The action panel is lightweight — it's a form with a few inputs and transaction state. The performance-critical piece is the observer, which is already specified. The pro-rata estimate recalculates on each poll cycle but is a trivial computation (a few divisions per hop).

---

## URL Routing

The app has two entry points:

| Route | View | Notes |
|---|---|---|
| `/` | Main app (observer + action panel) | Default. Shows observer + Commit/Invite/Claim tabs. |
| `/invite?inviter=…&fromHop=…&nonce=…&deadline=…&sig=…` | Invite redemption landing | Invitee-facing. Shows invite details, connect wallet, commit. After success, redirects to main app. |

The `/invite` route renders `InviteLinkRedemption.tsx` — a focused single-purpose page. It does NOT show the full observer or action panel until the invite is accepted. After acceptance, the invitee is redirected to `/` where they see their new position in the observer and can proceed to commit.

If the invite link is invalid, expired, or already redeemed, the landing page shows the appropriate error with a link to the main app.

---

## Scope Boundaries

**In scope:**
- Wallet connection and chain verification
- USDC commitment flow with per-hop amount entry, pro-rata estimates, and review/confirm
- USDC approval handling (ERC-20 approve before first commit)
- Invite link creation (EIP-712 signatures, shareable URLs) with batch creation
- Invite link redemption landing page
- Direct invite by address (fallback)
- Self-invite shortcut
- Invite nonce revocation
- ARM claim with mandatory delegation
- USDC refund claim
- Connected address highlighting in observer
- Transaction state management with human-readable error messages
- State-dependent tab visibility
- Embedded observer (full tree + table + stats banner)
- Client-side storage of generated invite links (IndexedDB)

**Out of scope:**
- Allocation preview for uncommitted participants ("what would I get if I were invited?")
- Batch operations (commit to all hops in one transaction — not supported by contract)
- Social features (messaging between participants, invite request flow)
- Admin/launch-team interface (hop-0 management, launch-team invite budget — handled via direct contract calls or separate tooling)
- Invite link recovery across devices (links are stored client-side only — inviter must copy/save them)

**Deferred but designed for:**
- Mobile-native experience (currently responsive web — tabbed layout on mobile)
- Multi-language support
- Accessibility audit (semantic HTML and ARIA labels should be built in from the start, but formal audit is deferred)
