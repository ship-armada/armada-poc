# Wind-Down Redemption Runbook

Operational procedure for the period between a wind-down trigger and the opening of
redemptions. This runbook exists because `ArmadaRedemption` is immutable and admin-less:
every mitigation for redemption-time footguns is either baked into contracts already
deployed, or executed operationally during the 7-day `REDEMPTION_DELAY` window described
here. **This document should be rehearsed before mainnet launch and kept current.**

Related: issue #256 (forgotten-token forfeiture), issue #254 (redeem-before-sweep),
threat model entry 8 (`reports/threat-model-governance-crowdfund.md`).

## Background: the two redemption footguns

`ArmadaRedemption.redeem(armAmount, tokens[], ethRecipient)` pays out **only the assets
the caller lists**. Deposited ARM is locked permanently regardless of what was listed.
Two consequences:

1. **Forgotten token (issue #256, accepted residual):** a redeemer who omits a swept,
   available token from `tokens[]` silently and irreversibly forfeits their pro-rata
   share of it; the value dilutes to later redeemers. The transaction succeeds — there
   is no on-chain signal of the loss. ETH cannot be forgotten (`ethRecipient` must be
   non-zero when the pool holds ETH), and listing a not-yet-swept token reverts
   (`zero share for token`), but omitting an available token is unguarded on-chain.
2. **Late sweep:** an asset swept *after* a user redeems is forfeited by that user even
   if their list was complete at the time. No contract change can fix this under the
   sequential pro-rata design — the only mitigation is completing all sweeps before the
   first redemption, which is what this runbook's window checklist ensures.

The decision on #256 was to accept the residual on-chain and mitigate operationally,
anchored by a **pre-built, never-deployed-at-launch periphery contract**:
`contracts/periphery/RedemptionRouter.sol`. It bakes the complete swept-token list in
at construction and exposes `redeemAll(armAmount, recipient)`, making the safe path the
zero-effort path for both UI and direct (block-explorer) callers.

## Roles

- **Coordinator:** whoever executes this runbook. Wind-down functions are permissionless,
  so any competent party can act — the team if present, otherwise any motivated ARM
  holder. Nothing here requires admin keys except nothing at all: sweeps, router
  deployment, and manifest publication are all permissionless or key-agnostic.
- **Redeemers:** ARM holders. Their instructions are in the final section.

## The 7-day window checklist

`REDEMPTION_DELAY` gives 7 days between `triggerTime` and the earliest possible
redemption. Complete these steps **in order, well before day 7**.

### 1. Sweep everything (day 0–1)

For every asset the treasury holds, call on `ArmadaWindDown`:

- `sweepToken(token)` — once per ERC-20 (permissionless, anyone may call)
- `sweepETH()` — once for ETH

Enumerate treasury assets from: fee-accrual history, treasury transaction history on a
block explorer, and any governance records of received assets. **Do not rely on memory —
an asset nobody sweeps is an asset every early redeemer forfeits.** Re-check treasury
balances after sweeping; residual dribbles (e.g. late fee arrivals) need a second sweep.

### 2. Deploy the RedemptionRouter (day 1–3, after sweeps are complete)

```bash
# Dry run: builds the token list from TokenSwept events, cross-checks balances,
# warns about unswept treasury remainders.
npx hardhat run scripts/deploy_redemption_router.ts --network <hub network>

# Review the printed list, then:
CONFIRM_ROUTER_DEPLOY=1 npx hardhat run scripts/deploy_redemption_router.ts --network <hub network>
```

The script refuses to run pre-trigger (except on local, for rehearsal), warns on unswept
balances, verifies the deployed router's `allTokens()` against the intended list, and
writes a `redemption-router-*.json` manifest.

Then **verify the router's source code on the block explorer**. This is not optional:
users are asked to approve ARM to a contract they have never seen, on a dead protocol —
exactly the setting phishing thrives in. An unverifiable router should be treated as
hostile.

### 3. Publish the canonical redemption manifest (day 3–5)

Publish, in as many durable places as practical (repo, IPFS, project channels), a signed
announcement containing:

- The **router address** and a statement that its source is verified.
- The **complete swept-token list**, sorted ascending — byte-for-byte what
  `router.allTokens()` returns.
- For direct callers: a literal `redeem()` calldata template using that list.
- The earliest redemption timestamp (`triggerTime + 7 days`).
- A warning to approve ARM **only** to the published router address.

Anyone can independently verify the manifest against on-chain state: `TokenSwept` events
on `ArmadaWindDown`, balances on `ArmadaRedemption`, and `router.allTokens()`.

### 4. Monitor (day 7 onward)

Optional but recommended: watch `Redeemed` events on `ArmadaRedemption` and alert if any
redemption's `tokens[]` does not cover all non-zero contract balances — this catches a
bad manifest or misbehaving UI after one incident instead of many. Watch treasury
balances for late asset arrivals; if any appear, sweep them and update the manifest
(late redeemers will pick them up; already-redeemed users' shares are forfeited — see
footgun 2 above).

## Instructions for redeemers

**Recommended path (router):**

1. Confirm the router address against the signed manifest — from more than one source.
2. Read `router.allTokens()` and check it matches the manifest's token list.
3. `approve` the router on the ARM token for your redemption amount.
4. Call `redeemAll(armAmount, recipient)`. `recipient` receives every payout (all
   ERC-20 shares and the ETH share); pass your own address unless you have a reason
   not to. Smart-contract wallets that cannot receive ETH should pass an address that
   can — if the ETH transfer fails, the whole call reverts and your ARM is safe.

**Direct path (no router):** call `ArmadaRedemption.redeem(armAmount, tokens, ethRecipient)`
with the manifest's **complete** token list (ascending order, no duplicates) and a
non-zero `ethRecipient`. Any token you omit is forfeited permanently — copy the list from
the manifest, do not compose it from memory.

**If in doubt, sell instead of redeeming.** ARM is freely transferable after wind-down.
Selling to a sophisticated redeemer at a small discount to net asset value is a
legitimate exit that avoids composing redemption calldata entirely.

**Never** redeem before confirming the manifest exists and sweeps are complete — redeeming
early forfeits your share of anything not yet swept, and the 7-day delay exists precisely
to make waiting safe.

## Rehearsal (local)

The full flow is exercised continuously in CI
(`test/winddown_redemption_integration.ts` — "RedemptionRouter" block, and
`test-foundry/RedemptionRouter.t.sol`). A manual rehearsal on a local stack:

```bash
npm run chains && npm run setup
# trigger wind-down via governance (or warp past the deadline), run sweeps, then:
npx hardhat run scripts/deploy_redemption_router.ts --network hub
```

## Design notes

- The router is **not** deployed at launch and must never be wired into `npm run setup`.
  Its absence from the deployment pipeline is deliberate: the token list only exists
  post-sweep.
- The router is immutable and admin-less, like the core redemption contract. A wrong
  token list means deploying a fresh router and updating the manifest — never mutating.
- Keeping the router + tests in-tree is what keeps this runbook executable: CI fails if
  interface drift ever breaks the router against `ArmadaRedemption`, so the contingency
  cannot rot silently. After `ArmadaRedemption` is deployed its interface is frozen, so
  post-launch drift risk is nil.
