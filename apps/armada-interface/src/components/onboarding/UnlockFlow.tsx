// ABOUTME: Returning-user unlock — two modes (paste root_secret hex, upload backup file) gated by Tabs.
// ABOUTME: Re-signing was explored but removed (specs/TX_SIGNING.md §"Recovery"): non-deterministic wallets produce a different identity each time. Paste / backup are the canonical paths.

import { useId, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button } from '@armada/ui'
import { OnboardingLayout } from '@/components/OnboardingLayout/OnboardingLayout'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { Tabs, Tooltip } from '@/components/ui'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { clearStoredWalletIdentity } from '@/lib/railgun/wallet'
import styles from './UnlockFlow.module.css'

export interface UnlockFlowProps {
  /** Called when unlock succeeds. Parent flips App-level mode to "app". */
  onUnlocked: () => void
  /**
   * Optional escape hatch — switches to the create-new-account flow. Hidden on testnet when this
   * device already had a wallet at boot (avoid orphaning). Always available in local mode.
   */
  onCreateNew?: () => void
  /** Override for the create-new link label (e.g. local dev "Start over…"). */
  createNewLabel?: string
}

type Mode = 'backup' | 'paste'

// Backup-file is the canonical recovery path — it's what the onboarding ceremony actually
// produces. Paste-secret is an escape hatch for users who exported the raw hex from Settings.
// Order here = tab order = default selected tab.
const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'backup', label: 'Backup file' },
  { id: 'paste', label: 'Paste secret' },
]

/** Example only — 64 hex chars, matches unlock validation shape. */
const PASTE_SECRET_PLACEHOLDER =
  '09fa2bfde60ba3f291c8b7e0c4d8e1f2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0'

const PASTE_HEADS_UP =
  'Pasting the raw secret triggers a full chain rescan to recover your balances. This can take a few minutes on the first unlock. For faster restores in the future, use the encrypted Backup file instead — and re-export a fresh backup from Settings once this scan completes.'

export function UnlockFlow({ onUnlocked, onCreateNew, createNewLabel }: UnlockFlowProps) {
  const { unlockByPaste, unlockByBackup } = useShieldedWallet()
  const [mode, setMode] = useState<Mode>('backup')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Per-mode form state. Kept separate so switching tabs doesn't carry data across modes
  // (especially the paste field — we don't want a hex secret lingering in the file-mode tab).
  const [pasteValue, setPasteValue] = useState('')
  const [pasteFromClipboard, setPasteFromClipboard] = useState(false)
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

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText()
      setPasteValue(text.trim())
      setError(null)
      setPasteFromClipboard(true)
      window.setTimeout(() => setPasteFromClipboard(false), 1200)
    } catch {
      // Clipboard read can fail in iframes or insecure contexts.
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
    <OnboardingLayout>
      <div className={styles.flow}>
        <section className={styles.shell} aria-label="Unlock your account">
        <Tabs items={MODES} selected={mode} onSelect={switchMode} ariaLabel="Unlock method" />

        {mode === 'paste' && (
          <form className={styles.modeForm} onSubmit={handlePasteSubmit}>
            <div className={styles.modeFormFields}>
              <p className={styles.body}>
                Paste your 64-character recovery secret to restore this account.{' '}
                <Tooltip
                  variant="rich"
                  title="About pasting your recovery secret"
                  description={PASTE_HEADS_UP}
                >
                  <button
                    type="button"
                    className={styles.infoTrigger}
                    aria-label="About pasting your recovery secret"
                  >
                    <svg className={styles.infoIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm8.706-1.442c1.146-.573 2.437.463 2.126 1.706l-.709 2.836.042-.02a.75.75 0 0 1 .67 1.34l-.04.022c-1.147.573-2.438-.463-2.127-1.706l.71-2.836-.042.02a.75.75 0 1 1-.671-1.34l.041-.022ZM12 9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
                      />
                    </svg>
                  </button>
                </Tooltip>
              </p>
              <div className={styles.secretField}>
                <textarea
                  id={pasteInputId}
                  rows={2}
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  className={styles.secretInput}
                  placeholder={PASTE_SECRET_PLACEHOLDER}
                  aria-label="Recovery secret (64 hexadecimal characters)"
                  value={pasteValue}
                  disabled={submitting}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                    setPasteValue(e.target.value)
                    setError(null)
                  }}
                />
                <div className={styles.pasteBtnWrap}>
                  <Button
                    variant="secondary"
                    size="sm"
                    label={pasteFromClipboard ? 'Pasted' : 'Paste'}
                    showIcon={false}
                    disabled={submitting}
                    onClick={handlePasteFromClipboard}
                  />
                </div>
              </div>
              {error ? (
                <div role="alert" className={styles.error}>{error}</div>
              ) : null}
            </div>
            <FlowFooter
              className={styles.footer}
              layout="stack"
              primary={{
                label: submitting ? 'Unlocking…' : 'Unlock',
                type: 'submit',
                disabled: !pasteValue,
                loading: submitting,
                showIcon: false,
              }}
            />
          </form>
        )}

        {mode === 'backup' && (
          <form className={styles.modeForm} onSubmit={handleBackupSubmit}>
            <div className={styles.modeFormFields}>
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
            </div>
            <FlowFooter
              className={styles.footer}
              layout="stack"
              primary={{
                label: submitting ? 'Unlocking…' : 'Unlock',
                type: 'submit',
                disabled: !backupFile || !backupPassphrase,
                loading: submitting,
                showIcon: false,
              }}
            />
          </form>
        )}
        </section>
        {onCreateNew ? (
          <div className={styles.createNew}>
            <span>{createNewLabel ? 'Stuck on unlock?' : "Don't have a backup?"}</span>
            <button
              type="button"
              className={styles.createNewLink}
              onClick={() => {
                clearStoredWalletIdentity()
                onCreateNew()
              }}
            >
              {createNewLabel ?? 'Create a new account instead'}
            </button>
          </div>
        ) : null}
      </div>
    </OnboardingLayout>
  )
}
