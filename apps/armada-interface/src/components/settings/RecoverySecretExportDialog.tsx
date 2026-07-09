// ABOUTME: Settings → Export recovery secret. Two modes — encrypted backup file (default) + raw hex (secondary, opt-in).
// ABOUTME: All paths require an unlocked session; the dialog clears state on close so revealed material never outlives it.

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Check, Download, Eye, KeyRound } from 'lucide-react'
import { Modal, Tabs } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { getRootSecret } from '@/lib/railgun/keyManager'
import { normalizeBackupUnlockError, verifyBackupFileText } from '@/lib/crypto/kdf'
import styles from './RecoverySecretExportDialog.module.css'

export interface RecoverySecretExportDialogProps {
  open: boolean
  onClose: () => void
}

type Mode = 'file' | 'hex'

const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'file', label: 'Backup file' },
  { id: 'hex', label: 'Show hex' },
]

/** Minimum backup passphrase length — matches `encryptBackup`'s own floor. */
const MIN_PASSPHRASE_LENGTH = 8

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function RecoverySecretExportDialog({ open, onClose }: RecoverySecretExportDialogProps) {
  const { exportBackup, state } = useShieldedWallet()
  const [mode, setMode] = useState<Mode>('file')

  // File mode state
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // Verify-your-backup sub-step state (shown after download). Confirms the downloaded file actually
  // restores — re-upload it + re-enter the passphrase; we decrypt and match the live checksum.
  const [verifyFile, setVerifyFile] = useState<File | null>(null)
  const [verifyPassphrase, setVerifyPassphrase] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  // Hex mode state
  const [revealedHex, setRevealedHex] = useState<string | null>(null)
  const [hexError, setHexError] = useState<string | null>(null)

  // Reset state on close — never retain revealed material beyond the dialog's lifetime.
  useEffect(() => {
    if (open) return
    setMode('file')
    setPassphrase('')
    setError(null)
    setSubmitting(false)
    setDownloaded(false)
    setVerifyFile(null)
    setVerifyPassphrase('')
    setVerifying(false)
    setVerified(false)
    setVerifyError(null)
    setRevealedHex(null)
    setHexError(null)
  }, [open])

  async function handleFileSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!passphrase) return
    setError(null)
    setSubmitting(true)
    try {
      const blob = await exportBackup(passphrase)
      const json = JSON.stringify(blob, null, 2)
      const fileBlob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(fileBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'armada-backup.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setPassphrase('')
      setDownloaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!verifyFile || !verifyPassphrase || !state?.checksum) return
    setVerifyError(null)
    setVerifying(true)
    setVerified(false)
    try {
      const text = await verifyFile.text()
      // Shared round-trip verifier (parse → decrypt → checksum match → zeroize) — same helper as
      // onboarding's ConfirmBackupStep so the two verification paths can't drift.
      await verifyBackupFileText(text, verifyPassphrase, state.checksum)
      setVerified(true)
    } catch (err) {
      setVerifyError(normalizeBackupUnlockError(err).message)
    } finally {
      setVerifying(false)
    }
  }

  function handleRevealHex() {
    setHexError(null)
    try {
      // Read directly from keyManager — we don't proxy through the hook because there's no
      // good reason to route this through useShieldedWallet's atom plumbing. The keyManager
      // throws when the wallet is locked.
      const rs = getRootSecret()
      setRevealedHex(bytesToHex(rs))
    } catch (err) {
      setHexError(err instanceof Error ? err.message : 'Could not reveal recovery secret.')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export recovery secret" wrapBody>
      <div className={styles.root}>
        <Tabs items={MODES} selected={mode} onSelect={setMode} ariaLabel="Export mode" />

        {mode === 'file' && !downloaded && (
          <form className={styles.section} onSubmit={handleFileSubmit}>
            <div className={styles.icon} aria-hidden="true">
              <KeyRound size={32} />
            </div>
            <p className={styles.body}>
              Choose a passphrase. We'll encrypt your recovery secret into a downloadable file you
              can store offline. You need both the file and this passphrase to restore.
            </p>
            <div className={styles.field}>
              <label htmlFor="export-passphrase" className={styles.label}>
                Passphrase
              </label>
              <input
                id="export-passphrase"
                type="password"
                autoComplete="new-password"
                autoFocus
                className={styles.input}
                value={passphrase}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setPassphrase(e.target.value)
                  setError(null)
                }}
              />
              <p className={styles.hint}>
                Use at least {MIN_PASSPHRASE_LENGTH} characters; a memorable 12–16+ character
                passphrase is much stronger.
              </p>
            </div>
            {error ? (
              <div role="alert" className={styles.error}>{error}</div>
            ) : null}
            <FlowFooter
              className={styles.footer}
              primary={{
                label: submitting ? 'Encrypting…' : 'Download backup',
                type: 'submit',
                disabled: passphrase.length < MIN_PASSPHRASE_LENGTH || submitting,
              }}
              secondary={{ label: 'Cancel', onClick: onClose }}
            />
          </form>
        )}

        {mode === 'file' && downloaded && (
          <form className={styles.section} onSubmit={handleVerify}>
            <div className={styles.success}>
              <Download size={16} aria-hidden="true" /> Backup downloaded. Keep this file safe.
            </div>
            <p className={styles.body}>
              Confirm it restores: re-upload the file you just saved and enter the same passphrase.
              We decrypt it locally and check it matches your wallet.
            </p>
            <div className={styles.field}>
              <label htmlFor="verify-file" className={styles.label}>
                Backup file
              </label>
              <input
                id="verify-file"
                type="file"
                accept="application/json,.json"
                className={styles.input}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setVerifyFile(e.target.files?.[0] ?? null)
                  setVerifyError(null)
                  setVerified(false)
                }}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="verify-passphrase" className={styles.label}>
                Passphrase
              </label>
              <input
                id="verify-passphrase"
                type="password"
                autoComplete="off"
                className={styles.input}
                value={verifyPassphrase}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setVerifyPassphrase(e.target.value)
                  setVerifyError(null)
                  setVerified(false)
                }}
              />
            </div>
            {verifyError ? (
              <div role="alert" className={styles.error}>{verifyError}</div>
            ) : null}
            {verified ? (
              <div className={styles.success}>
                <Check size={16} aria-hidden="true" /> Verified — this backup restores correctly.
              </div>
            ) : null}
            <FlowFooter
              className={styles.footer}
              primary={
                verified
                  ? { label: 'Done', onClick: onClose }
                  : {
                      label: verifying ? 'Verifying…' : 'Verify backup',
                      type: 'submit',
                      disabled: !verifyFile || !verifyPassphrase || verifying,
                    }
              }
              secondary={verified ? undefined : { label: 'Skip', onClick: onClose }}
            />
          </form>
        )}

        {mode === 'hex' && (
          <div className={styles.section}>
            <div className={styles.icon} aria-hidden="true">
              <Eye size={32} />
            </div>
            <p className={styles.body}>
              The raw recovery secret is 64 hexadecimal characters. Anyone with this value can spend
              your private balance — never paste it into a website you don't fully trust.
            </p>
            {hexError ? (
              <div role="alert" className={styles.error}>{hexError}</div>
            ) : null}
            {revealedHex ? (
              <div className={styles.hex} aria-label="Recovery secret (hex)">
                {revealedHex}
              </div>
            ) : null}
            <FlowFooter
              className={styles.footer}
              primary={
                revealedHex
                  ? { label: 'Done', onClick: onClose }
                  : { label: 'Reveal hex', onClick: handleRevealHex }
              }
              secondary={revealedHex ? undefined : { label: 'Cancel', onClick: onClose }}
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
