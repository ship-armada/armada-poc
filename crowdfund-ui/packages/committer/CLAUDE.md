# @armada/crowdfund-committer

The primary participant interface for the Armada crowdfund: commit USDC, issue invites, and claim ARM/refunds. Embeds the observer (tree + table + stats banner) as a read-only panel alongside a wallet-connected action panel.

## Spec

**Read this first:** `../../../../.context/CROWDFUND_COMMITTER.md`

The spec defines the full action surface: commit flow (per-hop amounts, pro-rata estimates, review/confirm), invite system (EIP-712 signed links + direct invites), claim flow (ARM with delegation + USDC refunds), wallet connection, transaction handling, and URL routing.

## Architecture

The app renders three primary surfaces driven by URL state (the `page` enum
in `App.tsx`):

- **Network** — full-bleed Hero (`CrowdfundExperience` from `@armada/crowdfund-shared`)
  with the NodeSphere, participants panel, and Progress card. Mock data flows
  through during initial deploy load; live data takes over once the indexer
  has events.
- **My Position** — same `CrowdfundExperience` shell, view switched to
  `'myposition'`. Drives the user's per-hop summary card + invite-slot card.
- **Participate** — opens as a portal-rendered modal (`ParticipateFlowModal`)
  wrapping `ParticipateFlowV2`. Multi-hop aware: per-hop amount entry,
  single-approve + N-commit pipeline, in-modal invite-slot step.
- **Claim** — `ClaimFlowV2` page. Handles ARM claim + delegation, and USDC
  refund for cancelled / below-min sales.
- **Invite Slots** — standalone `InviteSlotsPage` reached from the header.
  Renders per-hop sections from `useInviteSlots`.
- **`/invite?...`** — `InviteLandingPage` reads the EIP-712 invite link,
  pre-validates, and hands off to `InviteLinkFlowController` for the
  commitWithInvite path.

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
- `ClaimFlowV2.tsx` — page-level controller for the ARM-or-refund claim flow.
  Mirrors the commit modal aesthetic (480px lavender card, Step4Approve-style
  tx pipeline, Step5-style done screen).
- `InviteSlotsPage.tsx` — standalone Invite Slots page reachable from the
  header Invite button. Renders per-hop sections.
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
  invite-link state; consumed by both the MyPosition inline card and the
  standalone Invite Slots page.

## URL Routing

Two routes:
- `/` — main app
- `/invite?inviter=...&fromHop=...&nonce=...&deadline=...&sig=...` — invite link redemption landing

Use a lightweight router (react-router-dom or similar). The `/invite` route renders `InviteLandingPage.tsx`.

## Contract Write Functions

| Function | Tab | Notes |
|----------|-----|-------|
| `commit(hop, amount)` | Commit | One tx per hop. USDC approval required. |
| `invite(invitee, fromHop)` | Invite | Direct invite (Path B). Inviter pays gas. |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | Invite link | Atomic invite + commit (Path A). Invitee pays gas. |
| `revokeInviteNonce(nonce)` | Invite | On-chain revocation of a generated link. |
| `claim(delegate)` | Claim | ARM claim with mandatory delegation. |
| `claimRefund()` | Claim | USDC refund claim. |
