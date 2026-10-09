# @armada/crowdfund-committer

The primary participant interface for the Armada crowdfund: commit USDC, issue invites, and claim ARM/refunds. A full-bleed hero (network graph, participants, progress) with the commit, invite and claim actions in modals and cards over it.

## Spec

**Read this first:** `../../../specs/CROWDFUND_COMMITTER.md`

The spec predates the hero redesign — it still describes a split observer +
Commit/Invite/Claim tab layout. Its flows and contract rules hold; for the UI
structure, the Architecture section below and the code are the reference.

The spec defines the full action surface: commit flow (per-hop amounts, pro-rata estimates, review/confirm), invite system (EIP-712 signed links + direct invites), claim flow (ARM with delegation + USDC refunds), wallet connection, transaction handling, and URL routing.

## Architecture

The app renders two hero pages (the `page` enum in `App.tsx`) with modals over
them, all reachable from URL state:

- **Crowdfund** (`page === 'network'`) — full-bleed Hero (`CrowdfundExperience`
  from `@armada/crowdfund-shared`) with the NodeSphere, participants panel, and
  Progress card. Mock data flows through during initial deploy load; live data
  takes over once the indexer has events. Before the commit window opens
  (chain time < `windowStart` — not `!armLoaded`, since the deploy loads ARM
  up front) the Progress card reads `OPENS SOON` with an "OPENS IN …"
  countdown and a `PreOpenCard` countdown takes the Participate card's slot.
  Once the connected wallet has committed and holds invite slots, the
  invite-slot card (the same instance as on Your position) takes that slot
  instead; "Commit again" stays in the header (desktop) and on the Your
  position card.
- **Your position** (`page === 'my-position'`) — same `CrowdfundExperience`
  shell, view switched to `'myposition'`. Drives the user's per-hop summary
  card + invite-slot card. Disabled in the nav before the window opens.
- **Participate** — opens as a portal-rendered modal (`ParticipateFlowModal`)
  wrapping `ParticipateFlowV2`. Multi-hop aware: per-hop amount entry,
  single-approve + N-commit pipeline, in-modal invite-slot step. Hidden
  outside the commit window.
- **Claim** — a modal over the hero (never a selected page tab) wrapping
  `ClaimFlowV2`. Handles ARM claim + delegation, and USDC refund for
  cancelled / below-min sales. Disabled in the nav until claim opens.
- **Details** — `/observe` or `?view=observe` opens `ObserveDetailsModal`
  (status, participants, event log) over the hero.
- **`/invite?...`** — `InviteLandingPage` reads the EIP-712 invite link,
  pre-validates the link and sale state (e.g. a cancelled or not-yet-open
  sale), and hands off to `InviteLinkFlowController` for the commitWithInvite
  path.

## Development

```bash
# From project root
npm run crowdfund:committer    # Starts on port 5174

# Or from this directory
npm run dev
```

Requires deployed contracts (`npm run setup` from project root).

### Targeting a named Sepolia deployment

Local `setup:sepolia` overwrites `deployments/crowdfund-hub-sepolia.json` on every run, which is fine for ad-hoc deploys but disruptive when you want to test against a specific instance (e.g. `medi2` from the [armada-deployments](https://github.com/ship-armada/armada-deployments) repo).

```bash
# 1. Pull the named instance into deployments/instances/<name>/
npm run fetch-deployment -- medi2

# 2. Start the committer pointing at it
VITE_NETWORK=sepolia VITE_DEPLOYMENT_INSTANCE=medi2 npm run dev
```

The committer's `getDeploymentFileName()` resolves to `instances/<name>/sepolia/crowdfund.json` when `VITE_DEPLOYMENT_INSTANCE` is set; otherwise it falls back to the legacy `crowdfund-hub-sepolia.json`. Pulled instance files are gitignored — re-run `fetch-deployment` to refresh them.

### Pre-launch mode

Set `VITE_PRELAUNCH_OPENS_AT=<ISO 8601 UTC, e.g. 2026-10-08T17:00:00Z>` to build a countdown-only
committer for publishing the URL before the contracts exist. `main.tsx` then
renders `PreLaunchApp` on every path instead of the routes: the hero's pre-open
state (OPENS SOON, the opening countdown, an empty network) from that fixed
time, with no wallet button or sale actions and no manifest / RPC / indexer
reads. Once the time passes the page reloads every minute so open tabs pick up
the live deploy. `validateEnv` drops the indexer and expected-address
requirements in this mode and rejects a malformed value (whole seconds, explicit
`Z`). Use the same value as the deploy's `CROWDFUND_OPEN_TIME` — it becomes the
crowdfund's `windowStart`. Netlify setup and switch-over: `netlify.toml` header
and `specs/OPERATIONS.md` §3 Step 8.

```bash
# Preview locally
VITE_PRELAUNCH_OPENS_AT=2026-10-08T17:00:00Z npm run dev
```

## Dependencies

Most data-layer and view-component deps live in
`@armada/crowdfund-shared`. Committer-specific deps:
- `wagmi` + `@rainbow-me/rainbowkit` — wallet connection and chain management
- `viem` — wagmi peer dependency (also used for EIP-712 typed data signing)
- `ethers` — contract reads + writes
See `package.json` for the full list.

## Key Patterns

- **ethers v6** for contract reads/writes (not viem directly — wagmi wraps viem for wallet, ethers for contract calls)
- **Jotai** for shared state between observer and action panels
- **Tailwind v4** with shadcn/ui (New York style) for UI primitives
- **`@` path alias** maps to `src/`
- All source files must start with two-line ABOUTME comments

## App-Local Code

These components and hooks belong to this app (NOT in shared):

**Components** (`src/components/`):
- `ParticipateFlowV2.tsx` — wires the designer's Step1–Step5 commit flow to the
  committer's eligibility / balance / approve+commit transaction pipeline.
  Multi-hop aware.
- `ClaimFlowV2.tsx` — controller for the ARM-or-refund claim flow, rendered
  in the Claim modal. Mirrors the commit modal aesthetic (480px lavender card,
  Step4Approve-style tx pipeline, Step5-style done screen).
- `CommitterMobileMenu.tsx` — mobile nav sheet (wallet, Crowdfund / Your
  position / Claim, Participate card).
- `ObserveDetailsModal.tsx` — the Details modal (`Observe*` components).
- `InviteLinkFlowController.tsx` — the inline `/invite` step machine
  (`Step1Wallet → Step2Commit → Step3Review → Step4Approve → Step5Confirmation
  → 'invites'`), wired to `commitWithInvite`.
- `InviteLandingPage.tsx` — `/invite?...` landing chrome (logo + Step0Invite
  card + pre-validation gates).

**Hooks** (`src/hooks/`):
- `useWallet.ts` — wallet connection state (wagmi)
- `useEligibility.ts` — which hops is the connected address invited to?
- `useAllowance.ts` — USDC allowance check for commit flow
- `useInviteLinks.ts` — create, store, revoke invite links (EIP-712 + IndexedDB)
- `useInviteSlots.ts` — per-hop invite-slot sections derived from eligibility +
  invite-link state; consumed by the Your position card, the Participate
  modal's post-commit invite step, and the `/invite` flow.
- `useTxPipeline.ts` — per-address approve/commit/claim tx pipeline.
- `useStepTransition.ts` — exit-then-swap animation between modal steps.

**Pure helpers** (`src/lib/`) — e.g. `saleStatus.ts` (status pill + pre-open
check), `windowClock.ts` (chain-time → device-clock countdowns),
`claimModal.ts`, `submitWrite.ts`. Most have a sibling `*.test.ts`.

## URL Routing

Routes (react-router-dom, see `src/main.tsx`):
- `/` — main app. `?view=myposition` opens Your position; `?view=claim` opens
  the Claim modal; `?view=observe` opens the Details modal.
- `/observe` — same app with the Details modal open.
- `/invite?inviter=...&fromHop=...&nonce=...&deadline=...&sig=...` — invite link redemption landing (`InviteLandingPage.tsx`).

## Contract Write Functions

| Function | Surface | Notes |
|----------|---------|-------|
| `commit(hop, amount)` | Participate modal | One tx per hop. USDC approval required. |
| `invite(invitee, fromHop)` | Invite slots | Direct invite (Path B). Inviter pays gas. |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | `/invite` | Atomic invite + commit (Path A). Invitee pays gas. |
| `revokeInviteNonce(nonce)` | Invite slots | On-chain revocation of a generated link. |
| `claim(delegate)` | Claim modal | ARM claim with mandatory delegation. |
| `claimRefund()` | Claim modal | USDC refund claim. |
