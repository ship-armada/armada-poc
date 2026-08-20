# components/onboarding/

The account entry — a single state-agnostic **Sign In** for first visit and returning users alike (`SignInFlow`). Mounted by the top-level guard in `App.tsx`, never reachable as a route.

V2 redesign (Path C): deterministic sign-in is the primary path (same `signIn()` for new + returning); backup-file + paste-secret are secondary recovery, tucked behind a "Restore wallet from backup" link. See `specs/TX_SIGNING.md` + `specs/TX_SIGNING_V2_AMENDMENT.md`.

## Contents

| Component | Purpose |
|---|---|
| `OnboardingShell` | Non-dismissible `Modal` + `FlowHeader` wrapper. Owns the body padding; step content + footer flow inside. |
| `SignInFlow` | **Primary flow — one state-agnostic screen for first visit AND returning users.** `signIn()` first-derives (new) or re-derives (returning) the same identity, so there is no create/unlock split. Views: `sign-in` (connect + sign, with a state-agnostic two-signature note), `restore` (backup file [default] ⇄ paste secret, toggled by a text link), `signer-error` (renders `NonDeterministicSignerScreen`). Restore is reached via a quiet "Restore wallet from backup" link. |
| `OnboardingFlow` | Legacy 6-step flow (Welcome → Sign → Checksum → Backup → ConfirmBackup → Complete). **Dead** — not rendered by the app; still compiles + owns the `steps/*` components. Tests are `describe.skip`'d; kept until a deletion pass. |
| `NonDeterministicSignerScreen` | Full-page error rendered by `SignInFlow` when the determinism check fails on sign-in. Headline + body + supported/unsupported wallet compatibility lists + two CTAs (use backup/paste recovery → restore view; try a different wallet → disconnect + back to sign-in). |
## How the guard works

`App.tsx` tracks a local `mode` state (`pre-migration` / `pre-init` / `signin` / `app`). It runs the V2 schema migration on `pre-migration`, then derives the initial mode from `localStorage` + `shieldedWalletAtom.status` on mount, then transitions explicitly:

- On cold boot: `unlocked` (HMR re-mount) → `app`; otherwise seed the persisted walletId (if any) as a `locked` entry and go to `signin`. First-run (no persisted id) also lands on `signin` — signing in first-derives the wallet.
- `signin` → `app` when a sign-in or restore resolves and `SignInFlow` calls `onUnlocked`.
- `app` → `signin` when the atom flips to `locked` **or** `missing` (auto-lock timer, account-switch detection, tab-unload, hidden-tab grace expiry, Settings → Reset). See `lib/app-mode.ts::appModeForWalletStatus`.

There is no create/unlock fork and no "clear this browser's saved login" affordance — since sign-in is the only entry, a returning user can't accidentally orphan their wallet, so the old `hadPersistedWalletAtBoot` machinery is gone.

Why a local mode state instead of reading the atom directly? `useShieldedWallet().signIn()` flips the wallet atom to `unlocked` the moment the signature lands. If the guard read the atom directly, a sign-in in progress could unmount `SignInFlow` mid-transition. The local mode keeps the transition to `app` explicit (driven by `onUnlocked`).

## Key handling

- Keys are derived deterministically from an EIP-712 signature, not a generated mnemonic. The signature is captured at the Sign step; HKDF-SHA-256 produces a 32-byte `root_secret` held by `lib/shielded/keyManager` (module-scope, not in atoms, not in component state).
- The recovery export format is an encrypted JSON blob (`armada-backup-v2`), produced via Settings → Export recovery. The plaintext root_secret never enters component state or atoms.
- The anti-phish checksum (12 hex chars) IS exposed via `state.checksum` — it's a non-secret display value used to recognize an authentic unlock screen.
- All secret-handling rules from `lib/shielded/CLAUDE.md` apply: no `console.log`, no clipboard persistence beyond what the user pastes themselves, no atom storage of keys.

## Account-switch handling

When wagmi reports a new EVM address while the shielded wallet is unlocked (Phase 4), `useWallet` detects the mismatch via `keyManager.getEvmAddress()`, immediately calls `lockWallet()`, resets the active wallet atoms, and surfaces a `sonner` toast. The App-level guard flips to `signin`; `SignInFlow` shows the sign-in view, and the user signs in for the new EVM account.
