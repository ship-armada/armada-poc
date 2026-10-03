// ABOUTME: Shared wallet-confirm list — approve/commit rows with loading/done/error.
// ABOUTME: Optional Back/Retry when any row is errored; Claim + Participate reuse this.

import { useState, type ReactNode } from 'react'
import { Button } from '@armada/ui'
import styles from './WalletConfirmStep.module.css'

export type WalletTransactionStatus = 'pending' | 'loading' | 'done' | 'error'

export type WalletTransactionItem = {
  label: string
  status: WalletTransactionStatus
  /** Friendly summary under the label when status is `error`. */
  errorMessage?: string
  /** Optional raw/full error; shown behind a “Show details” toggle. */
  errorDetails?: string
  /** Secondary phase copy while loading (e.g. “Confirm in your wallet…”). */
  phaseLabel?: string
  /** Tx hash once broadcast. */
  hash?: string
  /** Block-explorer base URL; with `hash`, renders a short link. */
  explorerUrl?: string
}

const STATUS_LABEL: Record<WalletTransactionStatus, string> = {
  loading: 'Loading',
  pending: 'Pending',
  done: 'Complete',
  error: 'Error',
}

export interface WalletConfirmStepProps {
  /** Optional — omit when the parent chrome already shows the screen title. */
  title?: ReactNode
  transactions: readonly WalletTransactionItem[]
  footerText?: string
  /** Shown with Retry when any row is errored. */
  onBack?: () => void
  /** Shown with Back when any row is errored. */
  onRetry?: () => void
}

export function WalletConfirmStep({
  title,
  transactions,
  footerText = 'Waiting for wallet confirmation',
  onBack,
  onRetry,
}: WalletConfirmStepProps) {
  const [expandedDetails, setExpandedDetails] = useState<Record<number, boolean>>({})
  const hasError = transactions.some((t) => t.status === 'error')
  const showErrorActions = hasError && (!!onBack || !!onRetry)

  return (
    <div className={styles.root}>
      <div className={[styles.content, !title && styles.contentNoTitle].filter(Boolean).join(' ')}>
        {title ? <h2 className={styles.title}>{title}</h2> : null}

        <div className={styles.txCard} aria-live="polite" aria-label="Transaction status">
          {transactions.map((tx, i) => (
            <div key={`${tx.label}-${i}`} role="listitem">
              {i > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
              <div className={styles.txRow}>
                <div className={styles.txMain}>
                  <span className={styles.txLabel}>{tx.label}</span>
                  {(tx.status === 'loading' && tx.phaseLabel) || tx.hash ? (
                    <div className={styles.txMeta}>
                      {tx.status === 'loading' && tx.phaseLabel ? (
                        <span>{tx.phaseLabel}</span>
                      ) : null}
                      {tx.hash ? (
                        tx.explorerUrl ? (
                          <a
                            className={styles.txLink}
                            href={`${tx.explorerUrl}/tx/${tx.hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {`${tx.hash.slice(0, 6)}…${tx.hash.slice(-4)}`}
                            <span className={styles.visuallyHidden}> (opens in a new tab)</span>
                          </a>
                        ) : (
                          <span>{`${tx.hash.slice(0, 6)}…${tx.hash.slice(-4)}`}</span>
                        )
                      ) : null}
                    </div>
                  ) : null}
                  {tx.status === 'error' && tx.errorMessage ? (
                    <div className={styles.errorBlock}>
                      <div className={styles.errorMessage}>{tx.errorMessage}</div>
                      {tx.errorDetails && tx.errorDetails !== tx.errorMessage ? (
                        <>
                          <button
                            type="button"
                            className={styles.errorDetailsToggle}
                            aria-expanded={!!expandedDetails[i]}
                            onClick={() =>
                              setExpandedDetails((prev) => ({
                                ...prev,
                                [i]: !prev[i],
                              }))
                            }
                          >
                            {expandedDetails[i] ? 'Hide details' : 'Show details'}
                          </button>
                          {expandedDetails[i] ? (
                            <pre className={styles.errorDetails}>{tx.errorDetails}</pre>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className={styles.txStatus} aria-label={STATUS_LABEL[tx.status]}>
                  {tx.status === 'loading' ? (
                    <div className={styles.spinner} role="status" aria-label="Loading" />
                  ) : null}
                  {tx.status === 'pending' ? (
                    <div className={styles.circle} aria-hidden="true" />
                  ) : null}
                  {tx.status === 'done' ? (
                    <div className={styles.check} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M2 6L5 9L10 3"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  ) : null}
                  {tx.status === 'error' ? (
                    <div className={styles.checkError} aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="M3 3L9 9M9 3L3 9"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>
                  ) : null}
                  <span className={styles.visuallyHidden}>{STATUS_LABEL[tx.status]}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <footer className={styles.footer}>
        {showErrorActions ? (
          <div className={styles.footerActions}>
            {onBack ? (
              <Button
                variant="secondary"
                size="md"
                label="Back"
                showIcon={false}
                onClick={onBack}
              />
            ) : null}
            {onRetry ? (
              <Button
                variant="primary"
                size="md"
                label="Retry"
                showIcon={false}
                onClick={onRetry}
              />
            ) : null}
          </div>
        ) : (
          <p className={styles.footerText} aria-live="polite" aria-atomic="true">
            {hasError ? 'Transaction failed. Go back to retry.' : footerText}
          </p>
        )}
      </footer>
    </div>
  )
}
