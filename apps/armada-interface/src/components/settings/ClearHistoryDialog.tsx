// ABOUTME: Confirm-gated dialog for "Clear history (keep wallet)" — wipes the local txHistory store + checkpoint for the active wallet, then bumps the recovery epoch so the next scan rebuilds the synthetic rows from chain.
// ABOUTME: Lighter UX than ResetWalletDialog (no typed phrase) because the action is reversible — chain history is the source of truth and re-scanning rehydrates everything that hit on-chain.

import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Eraser } from 'lucide-react'
import { Modal } from '@/components/ui'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { activeShieldedWalletIdAtom } from '@/state/wallet'
import { txListAtom } from '@/state/tx'
import { requestLinksAtom } from '@/state/requestLinks'
import { historyRecoveryEpochAtom } from '@/state/history'
import { cacheClear } from '@/lib/cache'
import { clearHistoryCheckpoint } from '@/lib/shielded/history-checkpoint'
import { trackError } from '@/lib/telemetry'
import styles from './ClearHistoryDialog.module.css'

export interface ClearHistoryDialogProps {
  open: boolean
  onClose: () => void
}

export function ClearHistoryDialog({ open, onClose }: ClearHistoryDialogProps) {
  const walletId = useAtomValue(activeShieldedWalletIdAtom)
  const setTxList = useSetAtom(txListAtom)
  const setRequestLinks = useSetAtom(requestLinksAtom)
  const setEpoch = useSetAtom(historyRecoveryEpochAtom)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setSubmitting(false)
    setError(null)
  }, [open])

  async function handleClear() {
    setError(null)
    setSubmitting(true)
    try {
      // 1. Wipe the entire txHistory store. Encrypted envelopes for OTHER wallets co-tenant
      //    the same store, but a "clear local history" action that left them behind would be
      //    surprising — and they're equally re-recoverable from chain on next unlock. Cleaner
      //    to flush the whole store and let each wallet rebuild on its own scan.
      await cacheClear('txHistory')
      // 1b. Also wipe created payment-request links. Unlike tx history these are NOT chain-
      //     recoverable (local-only artifacts), so clearing is permanent — the shared links
      //     themselves keep working; only the local activity records go.
      await cacheClear('requestLinks')
      // 2. Drop the checkpoint so the next scan walks from the hub deploy block.
      if (walletId) clearHistoryCheckpoint(walletId)
      // 3. Reset the in-memory atoms so the UI immediately shows an empty activity feed.
      //    Without this the rows would linger until the next walletId-change re-hydration.
      setTxList([])
      setRequestLinks([])
      // 4. Bump the epoch so useHistoryRecovery's effect re-fires and starts the rescan.
      setEpoch((prev) => prev + 1)
      onClose()
    } catch (err) {
      trackError('history.clear', err, {
        scope: 'history.clear',
        message: 'failed to clear local history',
      })
      setError(err instanceof Error ? err.message : 'Clear failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Clear local history" wrapBody>
      <div className={styles.root}>
        <div className={styles.icon} aria-hidden="true">
          <Eraser size={32} />
        </div>
        <p className={styles.body}>
          This deletes the locally-stored activity records on this device. Your wallet stays
          intact and your funds are unaffected. Past transactions that hit the chain will be
          re-scanned and reappear automatically; locally-only state (pending/failed records
          that never reached the chain) cannot be recovered.
        </p>
        {error ? (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        ) : null}
        <FlowFooter
          className={styles.footer}
          primary={{
            label: submitting ? 'Clearing…' : 'Clear history',
            onClick: handleClear,
            disabled: submitting,
          }}
          secondary={{ label: 'Cancel', onClick: onClose }}
        />
      </div>
    </Modal>
  )
}
