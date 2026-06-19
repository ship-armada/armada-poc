// ABOUTME: Shared error step — circular error icon + category-aware headline + message + optional explorer link + Try Again / View Details CTAs.
// ABOUTME: Picks honest copy based on `error.code`: POLL_TIMEOUT / DISMISSED surface "may still complete" + an explorer link; TX_REVERTED is unambiguous failure; USER_REJECTED is friendly.

import { AlertCircle, ExternalLink } from 'lucide-react'
import { FlowFooter } from '../FlowFooter'
import type { TxError } from '@/lib/tx/types'
import styles from './ErrorStep.module.css'

/**
 * Category-specific copy for the error step. Sourced from `error.code` so the UI never reads
 * "Something went wrong" when we actually know what happened (e.g. we lost track of a still-mining
 * tx vs the user declined a wallet prompt).
 *
 * Centralized here rather than in stageCopy so the modal can stay dumb — pass the TxError, render
 * the right copy.
 */
const COPY_BY_CODE: Record<TxError['code'], { title: string; body?: string }> = {
  TX_REVERTED: {
    title: 'Transaction failed on chain',
    body: 'The network mined your transaction but the contract reverted. No funds were moved.',
  },
  PRE_FLIGHT_REVERT: {
    // No stock body — falls through to error.message, which carries the actual contract
    // revert reason from the pre-flight simulate (e.g. "InvalidNullifier",
    // "MerkleRootInvalid"). The title makes clear nothing was sent so the user doesn't
    // think they paid gas; the message tells them WHY the simulation rejected.
    title: 'Pre-flight check failed — nothing was sent',
  },
  POLL_TIMEOUT: {
    title: 'Lost track of your transaction',
    body: 'We stopped watching after the time budget elapsed. The transaction may still complete — check the explorer to confirm.',
  },
  RPC_ERROR: {
    title: 'Network error',
    body: 'We hit an error talking to the chain. Try again — your transaction may not have been submitted yet.',
  },
  USER_REJECTED: {
    title: 'Action declined',
    body: 'You declined the prompt in your wallet. Nothing was submitted.',
  },
  INTERRUPTED: {
    title: 'Transaction interrupted',
    body: 'This transaction was interrupted before it was sent — nothing left your wallet. Start a new transaction.',
  },
  FEE_EXPIRED: {
    title: 'Fee quote expired',
    body: 'The quoted fee was no longer valid when the relayer received your transaction. Nothing was sent — start a new transaction to get a fresh quote.',
  },
  DUPLICATE_TX: {
    title: 'Already submitted',
    body: 'The relayer already has this transaction — it may still complete. Check the explorer to confirm.',
  },
  CANCELLED: {
    title: 'Cancelled',
    body: 'No transaction was sent.',
  },
  DISMISSED: {
    title: 'Stopped tracking',
    body: 'You asked us to stop watching this transaction. It may still complete on chain — check the explorer.',
  },
  OTHER: {
    title: 'Something went wrong',
  },
}

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
  /** Try Again handler. Omit to disable the button (failing stage is not in lifecycle.retryableStages). */
  onRetry?: () => void
  /** View Details handler — typically expands the TechnicalDetailsDisclosure inside the body. */
  onViewDetails?: () => void
}

export function ErrorStep({
  error,
  message,
  explorerUrl,
  onRetry,
  onViewDetails,
}: ErrorStepProps) {
  const copy = error ? COPY_BY_CODE[error.code] : undefined
  const title = copy?.title ?? 'Something went wrong'
  // Prefer the category's stock body copy over the raw error.message — the raw message is often
  // technical (viem stack frames, RPC payloads) and our category-specific body is more useful.
  // If neither exists, fall back to the bare message prop (submit-time errors from modals).
  const body = copy?.body ?? error?.message ?? message

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
        primary={{ label: 'Try again', onClick: onRetry, disabled: !onRetry }}
        secondary={
          onViewDetails ? { label: 'View details', onClick: onViewDetails } : undefined
        }
      />
    </div>
  )
}
