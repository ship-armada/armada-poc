# @armada/crowdfund-committer

The primary participant interface for the Armada crowdfund: commit USDC, issue invites, and claim ARM/refunds. Embeds the observer (tree + table + stats banner) as a read-only panel alongside a wallet-connected action panel.

## Spec

**Read this first:** `../../../../.context/CROWDFUND_COMMITTER.md`

The spec defines the full action surface: commit flow (per-hop amounts, pro-rata estimates, review/confirm), invite system (EIP-712 signed links + direct invites), claim flow (ARM with delegation + USDC refunds), wallet connection, transaction handling, and URL routing.

## Architecture

Two halves:
- **Observer Panel (left ~60%)** — embeds shared view components from `@armada/crowdfund-shared` (StatsBar, TreeView, TableView). Same data, same visualization as the standalone observer.
- **Action Panel (right ~40%)** — wallet-connected, app-local. Three tabs: Commit, Invite, Claim. Context-aware — shows only actions available to the connected address in the current contract state.

The observer and action panels share the same data layer (from shared). The action panel adds wallet-specific hooks (useWallet, useEligibility, useAllowance, useProRataEstimate).

Desktop: side-by-side resizable split. Mobile: tabbed (Network / Participate).

## Development

```bash
# From project root
npm run crowdfund:committer    # Starts on port 5174

# Or from this directory
npm run dev
```

Requires deployed contracts (`npm run setup` from project root).

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
- `ActionPanel.tsx` — tab container (Commit / Invite / Claim)
- `CommitTab.tsx` — eligibility check, per-hop amount entry, review/confirm
- `InviteTab.tsx` — invite slot management, link creation (EIP-712), direct invite
- `InviteLinkRedemption.tsx` — landing page for `/invite?...` URL
- `ClaimTab.tsx` — ARM claim with delegation, USDC refund claim
- `ProRataEstimate.tsx` — estimated allocation display
- `TransactionFlow.tsx` — shared tx submission UI (pending → confirmed → error)
- `WalletHeader.tsx` — connected address, balance, network indicator
- `DelegateInput.tsx` — delegate address selector for ARM claim

**Hooks** (`src/hooks/`):
- `useWallet.ts` — wallet connection state (wagmi)
- `useEligibility.ts` — which hops is the connected address invited to?
- `useAllowance.ts` — USDC allowance check for commit flow
- `useTransactionFlow.ts` — submit tx → wait → confirm/error
- `useProRataEstimate.ts` — live pro-rata estimate from current demand
- `useInviteLinks.ts` — create, store, revoke invite links (EIP-712 + IndexedDB)

## URL Routing

Two routes:
- `/` — main app (observer + action panel)
- `/invite?inviter=...&fromHop=...&nonce=...&deadline=...&sig=...` — invite link redemption landing

Use a lightweight router (react-router-dom or similar). The `/invite` route renders `InviteLinkRedemption.tsx`.

## Contract Write Functions

| Function | Tab | Notes |
|----------|-----|-------|
| `commit(hop, amount)` | Commit | One tx per hop. USDC approval required. |
| `invite(invitee, fromHop)` | Invite | Direct invite (Path B). Inviter pays gas. |
| `commitWithInvite(inviter, fromHop, nonce, deadline, signature, amount)` | Invite link | Atomic invite + commit (Path A). Invitee pays gas. |
| `revokeInviteNonce(nonce)` | Invite | On-chain revocation of a generated link. |
| `claim(delegate)` | Claim | ARM claim with mandatory delegation. |
| `claimRefund()` | Claim | USDC refund claim. |
