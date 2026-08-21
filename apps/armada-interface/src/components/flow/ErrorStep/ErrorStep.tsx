// ABOUTME: Shared error step — circular error icon + category-aware headline + message + optional explorer link + Try Again / View Details CTAs.
// ABOUTME: Picks honest copy based on `error.code`: POLL_TIMEOUT / DISMISSED surface "may still complete" + an explorer link; TX_REVERTED is unambiguous failure; USER_REJECTED is friendly.

import { AlertCircle, ExternalLink } from 'lucide-react'
import { FlowFooter } from '../FlowFooter'
import type { TxError } from '@/lib/tx/types'
import { resolveTxErrorCopy } from '@/lib/tx/errorCopy'
import styles from './ErrorStep.module.css'

export interface ErrorStepProps {
  /**
   * Categorised error to render. Wins over `message` when present — surfaces the right title,
   * supporting copy, and (for POLL_TIMEOUT / DISMISSED) an explorer link.
   */
  error?: TxError | null
  /**
   * Fallback supporting message — used when no typed `error` is supplied (e.g. the modal caught a
   * submit-time throw before any record was created).
   */
  message?: string
  /**
   * Pre-built explorer URL (e.g. `https://sepolia.etherscan.io/tx/0x...`). Modal computes this
   * from `error.txHash` + the appropriate chain id since ErrorStep itself doesn't know which
   * chain the hash lives on.
   */
  explorerUrl?: string
  /** Primary action handler. Omit to disable the button. */
  onRetry?: () => void
  /**
   * Primary button label. Defaults to "Try again". Modals pass "Start over" when the failing stage
   * isn't retryable in place (e.g. build-proof, FEE_EXPIRED) and the action returns to the form for
   * a fresh transaction rather than re-running the dead stage. (S-M3)
   */
  primaryLabel?: string
  /** View Details handler — typically expands the TechnicalDetailsDisclosure inside the body. */
  onViewDetails?: () => void
}

export function ErrorStep({
  error,
  message,
  explorerUrl,
  onRetry,
  primaryLabel = 'Try again',
  onViewDetails,
}: ErrorStepProps) {
  // Category-aware copy (shared with the ActivityReceipt) — prefers the code's stock body over the
  // raw error.message (often technical), falling back to the bare message prop for submit-time throws.
  const { title, body } = resolveTxErrorCopy(error, message)

  return (
    <div className={styles.root}>
      <div className={styles.icon} aria-hidden="true">
        <AlertCircle size={36} />
      </div>
      <div className={styles.title}>{title}</div>
      {body ? <div className={styles.message}>{body}</div> : null}
      {explorerUrl ? (
        <a
          className={styles.explorerLink}
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on block explorer <ExternalLink size={14} aria-hidden="true" />
        </a>
      ) : null}
      <FlowFooter
        className={styles.footer}
        primary={{ label: primaryLabel, onClick: onRetry, disabled: !onRetry }}
        secondary={
          onViewDetails ? { label: 'View details', onClick: onViewDetails } : undefined
        }
      />
    </div>
  )
}
