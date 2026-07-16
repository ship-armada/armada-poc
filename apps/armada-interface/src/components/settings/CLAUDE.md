# components/settings/

Auxiliary dialogs for the Settings page — destructive actions are gated here so the page itself stays a flat list of options.

## Contents

| Component | Purpose |
|---|---|
| `RecoverySecretExportDialog` | Tabs over two modes — encrypted backup file (passphrase + browser download) and raw hex (opt-in reveal). Clears state on close so revealed material never outlives the dialog. |
| `ResetWalletDialog` | Destructive — requires typing "reset" before the Reset CTA enables. Calls `useShieldedWallet().reset()`. |
| `ClearHistoryDialog` | V1 Phase 9 — wipes the local `txHistory` IDB store + per-wallet checkpoint, then bumps `historyRecoveryEpochAtom` so the recovery hook rebuilds from chain. Single-confirm (no typed phrase) because the action is reversible via re-scan. |

## Conventions

- Dialogs use the `Modal` primitive directly (not `ActionFlowShell`) since they're single-screen, not multi-step flows.
- Open/close is controlled by Settings page-local state (not `openModalAtom`); these dialogs are Settings-internal.
- Secret-handling rules from `lib/railgun/CLAUDE.md` apply here: never `console.log` the mnemonic, never store it outside the dialog's local state, clear on close.

## Wired

- `useShieldedWallet().exportBackup` produces an `armada-backup-v1` blob via `lib/crypto/kdf::encryptRootSecret`. The dialog JSON-stringifies + downloads it.
- `useShieldedWallet().reset` deletes the SDK wallet entry, clears the keyManager + the cached walletId, and drops the active atom entry. The dialog surfaces any error inline.
