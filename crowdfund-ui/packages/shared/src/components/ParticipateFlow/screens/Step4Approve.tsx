// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step4Approve.tsx).
// ABOUTME: Extended with optional controlled `txs` prop + 'error' status so consumers can drive real-tx state (mock animation preserved when uncontrolled).

import { useEffect, useState, useRef } from 'react'
import styles from './Step4Approve.module.css'
import { Steps } from '@armada/ui'
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
  amount?: number
  /**
   * Controlled list of transactions. When provided, replaces the internal mock
   * animation — the consumer drives status updates and decides when to call
   * `onDone`. Omit for the standalone showcase/mock-preview behavior.
   */
  txs?: Transaction[]
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
  amount = 1000,
  txs: controlledTxs,
  steps = DEFAULT_STEPS,
  stepIndex = 4,
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
    // Controlled mode: the consumer owns timing + status. Skip the mock animation.
    if (controlledTxs) return
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
  }, [amount, onDone, controlledTxs])

  const txs = controlledTxs ?? internalTxs

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <h2 className={styles.title}>
          Confirm transactions<br />on your wallet
        </h2>

        {/* aria-live announces status changes to screen readers */}
        <div
          className={styles.txCard}
          aria-live="polite"
          aria-label="Transaction status"
          ref={liveRef}
        >
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
                  <div>
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
        <p
          className={styles.footerText}
          aria-live="polite"
          aria-atomic="true"
        >
          {txs.some((t) => t.status === 'error')
            ? 'Transaction failed. Go back to retry.'
            : 'Waiting for wallet confirmation'}
        </p>
      </div>
    </div>
  )
}
