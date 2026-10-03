// ABOUTME: Confirm approve + commit txs — FlowChrome shell over the shared WalletConfirmStep list.
// ABOUTME: Ported from the armada-crowdfund mockup; the POC's controlled `txs` API (error/phase/hash fields, onBack, onRetry) is preserved for the live committer + claim flows.

import { useEffect, useState, type ReactNode } from 'react'
import styles from './Step4Approve.module.css'
import { FlowChrome } from '../FlowChrome'
import {
  WalletConfirmStep,
  type WalletTransactionItem,
  type WalletTransactionStatus,
} from '../../WalletConfirm'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

/** Row status. Field-compatible with `WalletTransactionStatus`. */
export type TransactionStatus = WalletTransactionStatus

/**
 * A single wallet row. Aliased to the shared `WalletTransactionItem` so the
 * claim + participate pipelines keep the richer fields they already populate
 * (`errorMessage`, `errorDetails`, `phaseLabel`, `hash`, `explorerUrl`).
 */
export type Transaction = WalletTransactionItem

export interface Step4ApproveProps extends ParticipateStepBarProps {
  onDone: () => void
  /** Close control in the top chrome (preferred over the modal-level X). */
  onClose?: () => void
  /** Returns to Review with entered amounts preserved (chrome back, or the
   *  error-footer Back once a row has failed). */
  onBack?: () => void
  /** Re-runs the pipeline when a row errored (re-reads allowance so a
   *  succeeded approve isn't repeated). */
  onRetry?: () => void
  amount?: number
  /**
   * Controlled list of transactions. The consumer drives status updates and
   * decides when to call `onDone`.
   */
  txs?: readonly Transaction[]
  /**
   * Standalone showcase/mock-preview mode: runs the canned approve→commit
   * animation and auto-calls `onDone`. ONLY for design previews — never set this
   * in a real flow, or a confirmation would render with no transaction sent.
   * When false/omitted and `txs` is empty, a neutral "Preparing transaction…"
   * state renders and `onDone` is never called automatically.
   */
  showcase?: boolean
  /**
   * Optional headline rendered above the tx list. The claim flow uses it for a
   * singular variant since it submits a single tx; the participate flow leaves
   * it unset and relies on the chrome title.
   */
  title?: ReactNode
}

export default function Step4Approve({
  onDone,
  onClose,
  onBack,
  onRetry,
  amount = 1000,
  txs: controlledTxs,
  showcase = false,
  title,
}: Step4ApproveProps) {
  const [internalTxs, setInternalTxs] = useState<Transaction[]>([
    { label: `Approve ${amount.toLocaleString()} USDC`, status: 'loading' },
    { label: 'Commit participation', status: 'pending' },
  ])

  useEffect(() => {
    // Only the showcase preview runs the canned animation + auto-onDone. In a
    // real flow this never runs, so a missing `txs` can't fake a success.
    if (!showcase || controlledTxs) return
    const t1 = setTimeout(() => {
      setInternalTxs([
        { label: `Approve ${amount.toLocaleString()} USDC`, status: 'done' },
        { label: 'Commit participation', status: 'loading' },
      ])
    }, 2000)
    const t2 = setTimeout(() => {
      setInternalTxs([
        { label: `Approve ${amount.toLocaleString()} USDC`, status: 'done' },
        { label: 'Commit participation', status: 'done' },
      ])
      setTimeout(onDone, 400)
    }, 4000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [amount, onDone, showcase, controlledTxs])

  // Not showcase and no controlled rows → the consumer is still building the
  // pipeline (or bailed). Show a neutral row; never auto-complete.
  const preparing = !showcase && (!controlledTxs || controlledTxs.length === 0)
  const txs: readonly Transaction[] = preparing
    ? [{ label: 'Preparing transaction…', status: 'loading' }]
    : (controlledTxs ?? internalTxs)

  const hasError = txs.some((t) => t.status === 'error')
  // Back resets the consumer's pipeline and reopens Review with Confirm enabled,
  // so it must not be offered while a tx is being built, signed or mined.
  const inFlight = preparing || txs.some((t) => t.status === 'loading')

  return (
    <div className={styles.shell} data-flow-shell>
      <FlowChrome
        title={title ? undefined : 'Confirm'}
        showBack={!!onBack && !hasError && !inFlight}
        onBack={onBack}
        onClose={onClose}
      />

      <WalletConfirmStep
        title={title}
        transactions={txs}
        onBack={hasError ? onBack : undefined}
        onRetry={hasError ? onRetry : undefined}
        footerText={preparing ? 'Preparing transaction…' : 'Waiting for wallet confirmation'}
      />
    </div>
  )
}
