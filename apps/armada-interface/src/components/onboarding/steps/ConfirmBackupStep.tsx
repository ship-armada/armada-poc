// ABOUTME: Onboarding step — verifies the user can re-import their backup file by decrypting it locally and matching its checksum to the live one.
// ABOUTME: Pure dry-run: never touches keyManager, never calls SDK. Pass on success; surface decrypt failures inline.

import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react'
import { Text } from '@armada/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { normalizeBackupUnlockError, verifyBackupFileText } from '@/lib/crypto/kdf'
import styles from './PassphraseStep.module.css'

export interface ConfirmBackupStepProps {
  /** The user's live anti-phish checksum from the just-enrolled wallet; we match against this. */
  expectedChecksum: string
  onBack: () => void
  onConfirmed: () => void
}

export function ConfirmBackupStep({ expectedChecksum, onBack, onConfirmed }: ConfirmBackupStepProps) {
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idBase = useId()

  useEffect(() => {
    if (!verified) return
    const timer = window.setTimeout(() => onConfirmed(), 400)
    return () => clearTimeout(timer)
  }, [verified, onConfirmed])

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!file || !passphrase) return
    setError(null)
    setVerifying(true)
    setVerified(false)
    try {
      const text = await file.text()
      // Shared round-trip verifier (parse → decrypt → checksum match → zeroize). Same helper as
      // Settings → Export recovery so the two verification paths can't drift.
      await verifyBackupFileText(text, passphrase, expectedChecksum)
      setVerified(true)
    } catch (err) {
      setError(normalizeBackupUnlockError(err).message)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <form className={styles.root} onSubmit={handleSubmit}>
      <Text variant="display-lg" as="h2" className={styles.headline}>
        Confirm your backup
      </Text>
      <p className={styles.body}>
        Re-upload the backup file you just downloaded and enter the passphrase you set. This
        confirms you can restore your account — your account isn't activated until this succeeds.
      </p>
      <div className={styles.field}>
        <label htmlFor={`${idBase}-file`} className={styles.label}>
          Backup file
        </label>
        <input
          id={`${idBase}-file`}
          type="file"
          accept="application/json,.json"
          className={styles.input}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setFile(e.target.files?.[0] ?? null)
            setError(null)
            setVerified(false)
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${idBase}-pass`} className={styles.label}>
          Passphrase
        </label>
        <input
          id={`${idBase}-pass`}
          type="password"
          autoComplete="current-password"
          className={styles.input}
          value={passphrase}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setPassphrase(e.target.value)
            setError(null)
            setVerified(false)
          }}
        />
      </div>
      {error ? (
        <div role="alert" className={styles.error}>{error}</div>
      ) : null}
      {verified ? (
        <p className={styles.success}>Backup verified — checksum matches.</p>
      ) : null}
      <FlowFooter
        className={styles.footer}
        layout="stack"
        primary={{
          label: verifying ? 'Verifying…' : 'Verify backup',
          type: 'submit',
          disabled: !file || !passphrase || verifying || verified,
          showIcon: false,
        }}
        secondary={{ label: 'Back', onClick: onBack, disabled: verifying, showIcon: false }}
      />
    </form>
  )
}
