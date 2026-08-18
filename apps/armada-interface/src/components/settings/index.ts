// ABOUTME: Barrel export for the Settings overlay + its auxiliary dialogs (RecoverySecretExportDialog, ResetWalletDialog, ClearHistoryDialog).
// ABOUTME: SettingsModal consumes all three dialogs directly; tests can import them individually.

export { SettingsModal } from './SettingsModal'

export { RecoverySecretExportDialog } from './RecoverySecretExportDialog'
export type { RecoverySecretExportDialogProps } from './RecoverySecretExportDialog'

export { ResetWalletDialog } from './ResetWalletDialog'
export type { ResetWalletDialogProps } from './ResetWalletDialog'

export { ClearHistoryDialog } from './ClearHistoryDialog'
export type { ClearHistoryDialogProps } from './ClearHistoryDialog'
