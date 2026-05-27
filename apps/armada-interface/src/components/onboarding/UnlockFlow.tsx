// ABOUTME: Returning-user unlock — two modes (paste root_secret hex, upload backup file) gated by Tabs.
// ABOUTME: Re-signing was explored but removed (specs/TX_SIGNING.md §"Recovery"): non-deterministic wallets produce a different identity each time. Paste / backup are the canonical paths.

import { useId, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAtomValue } from 'jotai'
import { Lock } from 'lucide-react'
import { OnboardingShell } from './OnboardingShell'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { Tabs } from '@/components/ui'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { railgunEngineAtom } from '@/state/wallet'
import styles from './UnlockFlow.module.css'

export interface UnlockFlowProps {
  /** Called when unlock succeeds. Parent flips App-level mode to "app". */
  onUnlocked: () => void
  /**
   * Optional escape hatch — switches to the create-new-account flow. App.tsx only passes this
   * when there's no persisted walletId on this device, so a returning user (who has a real
   * wallet locally) can't accidentally orphan it by starting over.
   */
  onCreateNew?: () => void
}

type Mode = 'backup' | 'paste'

// Backup-file is the canonical recovery path — it's what the onboarding ceremony actually
// produces. Paste-secret is an escape hatch for users who exported the raw hex from Settings.
// Order here = tab order = default selected tab.
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'backup', label: 'Backup file' },
  { id: 'paste', label: 'Paste secret' },
]

export function UnlockFlow({ onUnlocked, onCreateNew }: UnlockFlowProps) {
  const { unlockByPaste, unlockByBackup } = useShieldedWallet()
  const engine = useAtomValue(railgunEngineAtom)
  const [mode, setMode] = useState<Mode>('backup')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // While a click is in flight and the engine hasn't finished warming, surface a distinct
  // "Warming engine…" label so the user understands why the button is busy. Mirrors the same
  // pattern in SignEnrollmentStep. Post-paint deferral of `initRailgunEngine()` (App.tsx) means
  // a user clicking Unlock before the idle-callback fires will see this state briefly.
  const warming = submitting && engine.state !== 'ready'
  const submittingLabel = warming ? 'Warming engine…' : 'Unlocking…'

  // Per-mode form state. Kept separate so switching tabs doesn't carry data across modes
  // (especially the paste field — we don't want a hex secret lingering in the file-mode tab).
  const [pasteValue, setPasteValue] = useState('')
  const [backupFile, setBackupFile] = useState<File | null>(null)
  const [backupPassphrase, setBackupPassphrase] = useState('')

  const pasteInputId = useId()
  const backupFileId = useId()
  const backupPassphraseId = useId()

  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setError(null)
    // Clear the in-progress field of the mode we're leaving so secrets don't sit in DOM state.
    if (mode === 'paste') setPasteValue('')
    if (mode === 'backup') {
      setBackupFile(null)
      setBackupPassphrase('')
    }
  }

  async function handlePasteSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!pasteValue) return
    setError(null)
    setSubmitting(true)
    try {
      await unlockByPaste(pasteValue)
      setPasteValue('') // drop the hex from React state once we've consumed it
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleBackupSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!backupFile || !backupPassphrase) return
    setError(null)
    setSubmitting(true)
    try {
      await unlockByBackup(backupFile, backupPassphrase)
      setBackupFile(null)
      setBackupPassphrase('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <OnboardingShell title="Unlock your account" currentStep={1} totalSteps={1} showIndicator={false}>
      <div className={styles.root}>
        <div className={styles.icon} aria-hidden="true">
          <Lock size={32} />
        </div>
        <Tabs items={MODES} selected={mode} onSelect={switchMode} ariaLabel="Unlock method" />

        {mode === 'paste' && (
          <form className={styles.root} onSubmit={handlePasteSubmit}>
            <p className={styles.body}>
              Paste your 64-character recovery secret to restore this account.
            </p>
            <p className={styles.body}>
              Heads up: pasting the raw secret triggers a full chain rescan to recover your
              balances. This can take a few minutes on the first unlock. For faster restores in
              the future, use the encrypted Backup file instead — and re-export a fresh backup
              from Settings once this scan completes.
            </p>
            <div className={styles.field}>
              <label htmlFor={pasteInputId} className={styles.label}>
                Recovery secret (hex)
              </label>
              <input
                id={pasteInputId}
                type="password"
                autoComplete="off"
                autoFocus
                spellCheck={false}
                className={styles.input}
                value={pasteValue}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setPasteValue(e.target.value)
                  setError(null)
                }}
              />
            </div>
            {error ? (
              <div role="alert" className={styles.error}>{error}</div>
            ) : null}
            <FlowFooter
              className={styles.footer}
              primary={{
                label: submitting ? submittingLabel : 'Unlock',
                type: 'submit',
                disabled: !pasteValue || submitting,
              }}
            />
          </form>
        )}

        {mode === 'backup' && (
          <form className={styles.root} onSubmit={handleBackupSubmit}>
            <p className={styles.body}>
              Choose a backup file from Settings → Export and enter the passphrase you set.
            </p>
            <div className={styles.field}>
              <label htmlFor={backupFileId} className={styles.label}>
                Backup file
              </label>
              <input
                id={backupFileId}
                type="file"
                accept="application/json,.json"
                className={styles.input}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setBackupFile(e.target.files?.[0] ?? null)
                  setError(null)
                }}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={backupPassphraseId} className={styles.label}>
                Passphrase
              </label>
              <input
                id={backupPassphraseId}
                type="password"
                autoComplete="current-password"
                className={styles.input}
                value={backupPassphrase}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setBackupPassphrase(e.target.value)
                  setError(null)
                }}
              />
            </div>
            {error ? (
              <div role="alert" className={styles.error}>{error}</div>
            ) : null}
            <FlowFooter
              className={styles.footer}
              primary={{
                label: submitting ? submittingLabel : 'Unlock',
                type: 'submit',
                disabled: !backupFile || !backupPassphrase || submitting,
              }}
            />
          </form>
        )}

        {onCreateNew ? (
          <p className={styles.createNew}>
            Don't have a backup?{' '}
            <button
              type="button"
              className={styles.createNewLink}
              onClick={onCreateNew}
            >
              Create a new account instead
            </button>
          </p>
        ) : null}
      </div>
    </OnboardingShell>
  )
}
