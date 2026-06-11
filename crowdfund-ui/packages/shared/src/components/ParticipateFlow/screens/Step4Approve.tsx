// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step4Approve.tsx).
// ABOUTME: Extended with optional controlled `txs` prop + 'error' status so consumers can drive real-tx state (mock animation preserved when uncontrolled).

import { useEffect, useState, useRef } from 'react'
import styles from './Step4Approve.module.css'
import { Steps, Button } from '@armada/ui'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

export type TransactionStatus = 'pending' | 'loading' | 'done' | 'error'

export interface Transaction {
  label: string
  status: TransactionStatus
  /** Friendly summary surfaced below the status icon when status is 'error'.
   *  Should be short and modal-width-friendly — the raw error goes in
   *  `errorDetails`. */
  errorMessage?: string
  /** Optional full / raw error string. When provided AND distinct from
   *  `errorMessage`, a "Show details" toggle appears under the summary that
   *  reveals this in a scrollable mono block. */
  errorDetails?: string
}

export interface Step4ApproveProps extends ParticipateStepBarProps {
  onDone: () => void
  /** Shown as a "Back" button when any tx row errored — returns to the review
   *  step with entered amounts preserved. */
  onBack?: () => void
  /** Shown as a "Retry" button when any tx row errored — re-runs the pipeline
   *  (which re-reads allowance so a successful approve isn't repeated). */
  onRetry?: () => void
  amount?: number
  /**
   * Controlled list of transactions. The consumer drives status updates and
   * decides when to call `onDone`.
   */
  txs?: Transaction[]
  /**
   * Standalone showcase/mock-preview mode: runs the canned approve→commit
   * animation and auto-calls `onDone`. ONLY for design previews — never set this
   * in a real flow, or a confirmation would render with no transaction sent.
   * When false/omitted and `txs` is empty, a neutral "Preparing transaction…"
   * state renders and `onDone` is never called automatically.
   */
  showcase?: boolean
  /**
   * Optional headline override. Defaults to the designer's two-line plural
   * copy ("Confirm transactions / on your wallet"). The claim flow swaps in
   * a singular variant since it submits a single tx.
   */
  title?: React.ReactNode
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

const STATUS_LABEL: Record<TransactionStatus, string> = {
  loading: 'Loading',
  pending: 'Pending',
  done: 'Complete',
  error: 'Error',
}

export default function Step4Approve({
  onDone,
  onBack,
  onRetry,
  amount = 1000,
  txs: controlledTxs,
  showcase = false,
  steps = DEFAULT_STEPS,
  stepIndex = 4,
  title,
}: Step4ApproveProps) {
  const [internalTxs, setInternalTxs] = useState<Transaction[]>([
    { label: `Approve ${amount.toLocaleString()} USDC`, status: 'loading' },
    { label: 'Commit participation', status: 'pending' },
  ])
  // Per-row "show details" toggle keyed by row index. Reset implicitly when
  // the component remounts (next attempt).
  const [expandedDetails, setExpandedDetails] = useState<Record<number, boolean>>({})
  const liveRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Only the showcase preview runs the canned animation + auto-onDone. In a
    // real flow this never runs, so a missing `txs` can't fake a success.
    if (!showcase) return
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
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [amount, onDone, showcase])

  const txs = controlledTxs ?? (showcase ? internalTxs : [])
  // Not showcase and no transactions yet → the consumer is still preparing the
  // pipeline (or bailed). Show a neutral state; never auto-complete.
  const preparing = !showcase && txs.length === 0
  const hasError = txs.some((t) => t.status === 'error')

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <h2 className={styles.title}>
          {title ?? (
            <>
              Confirm transactions<br />on your wallet
            </>
          )}
        </h2>

        {/* aria-live announces status changes to screen readers */}
        <div
          className={styles.txCard}
          aria-live="polite"
          aria-label="Transaction status"
          ref={liveRef}
        >
          {preparing && (
            <div className={styles.txRow}>
              <span className={styles.txLabel}>Preparing transaction…</span>
              <div className={styles.txStatus} aria-label={STATUS_LABEL.loading}>
                <div className={styles.spinner} role="status" aria-label="Loading" />
              </div>
            </div>
          )}
          {txs.map((tx, i) => (
            <div key={i} role="listitem">
              {i > 0 && <div className={styles.divider} aria-hidden="true" />}
              <div className={styles.txRow}>
                <span className={styles.txLabel}>{tx.label}</span>
                <div
                  className={styles.txStatus}
                  aria-label={STATUS_LABEL[tx.status]}
                >
                  {tx.status === 'loading' && (
                    <div
                      className={styles.spinner}
                      role="status"
                      aria-label="Loading"
                    />
                  )}
                  {tx.status === 'pending' && (
                    <div className={styles.circle} aria-hidden="true" />
                  )}
                  {tx.status === 'done' && (
                    <div className={styles.check} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  )}
                  {tx.status === 'error' && (
                    <div className={styles.checkError} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </div>
                  )}
                  {/* Visually hidden status text for AT */}
                  <span className={styles.visuallyHidden}>
                    {STATUS_LABEL[tx.status]}
                  </span>
                </div>
              </div>
              {tx.status === 'error' && tx.errorMessage && (() => {
                const hasDetails = !!tx.errorDetails && tx.errorDetails !== tx.errorMessage
                const expanded = !!expandedDetails[i]
                return (
                  <div className={styles.errorBlock}>
                    <div className={styles.errorMessage}>{tx.errorMessage}</div>
                    {hasDetails && (
                      <>
                        <button
                          type="button"
                          className={styles.errorDetailsToggle}
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedDetails((prev) => ({ ...prev, [i]: !prev[i] }))
                          }
                        >
                          {expanded ? 'Hide details' : 'Show details'}
                        </button>
                        {expanded && (
                          <pre className={styles.errorDetails}>{tx.errorDetails}</pre>
                        )}
                      </>
                    )}
                  </div>
                )
              })()}
            </div>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        {hasError && (onBack || onRetry) ? (
          <div className={styles.footerActions}>
            {onBack && (
              <Button variant="secondary" size="md" label="Back" showIcon={false} onClick={onBack} />
            )}
            {onRetry && (
              <Button variant="primary" size="md" label="Retry" showIcon={false} onClick={onRetry} />
            )}
          </div>
        ) : (
          <p
            className={styles.footerText}
            aria-live="polite"
            aria-atomic="true"
          >
            {preparing
              ? 'Preparing transaction…'
              : hasError
                ? 'Transaction failed. Go back to retry.'
                : 'Waiting for wallet confirmation'}
          </p>
        )}
      </div>
    </div>
  )
}
