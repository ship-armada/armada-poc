# components/onboarding/

First-run setup + returning-user unlock. Mounted by the top-level guard in `App.tsx`, never reachable as a route.

V2 redesign (Path C) landed: deterministic re-sign is the primary path; backup-file + paste-secret are retained as secondary recovery. See `specs/TX_SIGNING.md` + `specs/TX_SIGNING_V2_AMENDMENT.md`.

## Contents

| Component | Purpose |
|---|---|
| `OnboardingShell` | Non-dismissible `Modal` + `FlowHeader` wrapper. Owns the body padding; step content + footer flow inside. |
| `OnboardingFlowV2` | **Primary flow.** 4-step state machine: Welcome → Sign → Checksum → Complete (+ a `signer-error` mode for `NonDeterministicSignerError`). Drives `useShieldedWallet().signIn()`. Backup file export is opt-in via Settings → Export recovery, not gated on first-run. |
| `OnboardingFlow` | Legacy 6-step flow (Welcome → Sign → Checksum → Backup → ConfirmBackup → Complete). Not used by the app; still compiles via the `enroll` alias in `useShieldedWallet`. Tests are `describe.skip`'d; kept as reference until the next deletion pass. |
| `UnlockFlow` | **Three-tab unlock.** Tab 1 (default): "Sign in" — re-deriver via `signIn()`. Tab 2: "Backup file" — passphrase + file upload via `unlockByBackup()`. Tab 3: "Paste secret" — 64-char hex via `unlockByPaste()`. A `NonDeterministicSignerError` from Tab 1 auto-switches to Tab 2 with a banner. |
| `NonDeterministicSignerScreen` | Full-page error rendered by `OnboardingFlowV2` when the determinism check fails on first sign. Headline + body + supported/unsupported wallet compatibility lists + two CTAs (use backup/paste recovery / try a different wallet). |
| `steps/WelcomeStep` | Intro + Create CTA. Copy updated: no "you'll create a backup" framing — backup is opt-in. |
| `steps/SignEnrollmentStep` | EIP-712 sign prompt + in-flight/error state. Optional `onSignerIncompatible(reason)` callback for routing the typed error to the parent's dedicated screen. |
| `steps/AntiPhishChecksumStep` | Displays the live anti-phish checksum so the user recognizes their own wallet on later unlocks. |
| `steps/BackupPassphraseStep` | Passphrase entry + browser download of the encrypted `armada-backup-v2` blob. **Retained** post Path C; surfaced via Settings → Export recovery. |
| `steps/ConfirmBackupStep` | Re-upload + decrypt verification — confirms checksum matches the live wallet before activating. **Retained** for Settings-side export confirmation. |
| `steps/CompleteStep` | Success panel. Calls `onDone` to hand control back to App-level mode. Copy mentions Settings → Export recovery for cross-device backup. |

## How the guard works

`App.tsx` tracks a local `mode` state (`pre-migration` / `pre-init` / `onboarding` / `unlock` / `app`). It runs the V2 schema migration on `pre-migration`, then derives the initial unlock mode from `localStorage` + `shieldedWalletAtom.status` on mount, then transitions explicitly:

- `onboarding` → `app` when the user clicks Done in `CompleteStep`.
- `onboarding` → `unlock` when the user clicks the **Restore** secondary CTA on `WelcomeStep` (or the **Use a backup file or recovery secret** CTA on `NonDeterministicSignerScreen`).
- `unlock` → `onboarding` when the user clicks the **Create new account** link, *only when there was no persisted walletId at boot*. App.tsx tracks this via the sticky `hadPersistedWalletAtBoot` flag so a returning user can't orphan their existing wallet by misclicking.
- `app` → `unlock` when the atom flips to `locked` (auto-lock timer, account-switch detection, tab-unload, hidden-tab grace expiry).
- `unlock` → `app` when an unlock path resolves and `UnlockFlow` calls `onUnlocked`.

The Restore CTA is offered unconditionally in onboarding — the flow can't know whether a given visitor is genuinely new or arriving on a new device. The link is inert for genuinely-new users and load-bearing for the second case.

Why a local mode state instead of reading the atom directly? Because `useShieldedWallet().signIn()` writes to atoms BEFORE the user reaches Complete (the wallet is unlocked from the moment of Sign). If the guard read the atom directly, the post-sign screens would never render — the atom flip would unmount `OnboardingFlowV2` immediately. The local mode shields the flow until the user explicitly clicks through Complete.

## Key handling

- Keys are derived deterministically from an EIP-712 signature, not a generated mnemonic. The signature is captured at the Sign step; HKDF-SHA-256 produces a 32-byte `root_secret` held by `lib/shielded/keyManager` (module-scope, not in atoms, not in component state).
- The recovery export format is an encrypted JSON blob (`armada-backup-v2`), produced via Settings → Export recovery. The plaintext root_secret never enters component state or atoms.
- The anti-phish checksum (12 hex chars) IS exposed via `state.checksum` — it's a non-secret display value used to recognize an authentic unlock screen.
- All secret-handling rules from `lib/shielded/CLAUDE.md` apply: no `console.log`, no clipboard persistence beyond what the user pastes themselves, no atom storage of keys.

## Account-switch handling

When wagmi reports a new EVM address while the shielded wallet is unlocked (Phase 4), `useWallet` detects the mismatch via `keyManager.getEvmAddress()`, immediately calls `lockWallet()`, resets the active wallet atoms, and surfaces a `sonner` toast. The App-level guard flips to `unlock`, `UnlockFlow` lands on Tab 1 (Sign in), and the user signs in for the new EVM account.
