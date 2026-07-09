// ABOUTME: Confirms abandoning first-run setup after enrollment — wipes the in-progress wallet from this device.
// ABOUTME: Shown from AntiPhishChecksumStep when the user taps Cancel; parent supplies onConfirm (reset + route to welcome).

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Modal } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import styles from './CancelSetupConfirmDialog.module.css'

export interface CancelSetupConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}

export function CancelSetupConfirmDialog({ open, onClose, onConfirm }: CancelSetupConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setSubmitting(false)
    setError(null)
  }, [open])

  async function handleConfirm() {
    setError(null)
    setSubmitting(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel setup.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Cancel setup?" wrapBody>
      <div className={styles.root}>
        <div className={styles.icon} aria-hidden="true">
          <AlertTriangle size={32} />
        </div>
        <p className={styles.body}>
          Your private account was already created when you signed. Canceling removes it from this
          device. You will need to sign again to set up — and you have not created a backup yet, so
          there is nothing to restore.
        </p>
        {error ? (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        ) : null}
        <FlowFooter
          className={styles.footer}
          primary={{
            label: submitting ? 'Canceling…' : 'Cancel setup',
            onClick: handleConfirm,
            disabled: submitting,
            showIcon: false,
          }}
          secondary={{
            label: 'Keep setup',
            onClick: onClose,
            disabled: submitting,
            showIcon: false,
          }}
        />
      </div>
    </Modal>
  )
}
