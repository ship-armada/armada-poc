// ABOUTME: Per-record retry/cancel CTAs. Stage-aware: pre-broadcast records get "Cancel" (abort safely), post-broadcast records get "Stop tracking" (the on-chain tx still runs; we just stop watching).
// ABOUTME: Rendered inside History's expanded detail and inside ProgressStep (cancel only). Operates on TxRecord directly — no `useTx` subscription needed.

import { Button } from '@armada/ui'
import { cancelTx, canRetryTx, dismissTx, getIsLeader, retryTx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'
import styles from './TxActions.module.css'

export interface TxActionsProps {
  record: TxRecord
  /**
   * Subset of buttons to render. Default `'both'` shows Cancel/Stop + Retry depending on state.
   * Modals' Progress step uses `'cancel'` since they handle Retry via the dedicated ErrorStep.
   */
  variant?: 'both' | 'cancel'
}

const PRE_TERMINAL_STATES = new Set(['pending', 'active', 'waiting', 'retrying'])

/**
 * Decide whether the cancel/stop CTA reflects a pre-broadcast or post-broadcast record. Once a
 * sourceTxHash is set we've already broadcast — the chain is running its own clock and a
 * "Cancel" label would be dishonest. Switch to "Stop tracking" copy and call dismissTx, which
 * marks the record DISMISSED instead of CANCELLED so the UI can render explorer-link copy.
 */
function hasBroadcast(record: TxRecord): boolean {
  const sourceTxHash = (record.artifacts as { sourceTxHash?: `0x${string}` }).sourceTxHash
  return Boolean(sourceTxHash)
}

export function TxActions({ record, variant = 'both' }: TxActionsProps) {
  // Follower tabs can't drive the executor — handlers run only on the leader. A follower Retry
  // would wedge the record in `retrying` (retryTx refuses, but the dead button is worse than
  // absent), and a follower Cancel/Stop races the leader's authoritative state. Hide all actions;
  // the follower stays a passive observer. In v1 a follower never gains leadership (no failover),
  // so this is stable. (T-H3)
  if (!getIsLeader()) return null

  const isInFlight = PRE_TERMINAL_STATES.has(record.executionState)
  const canRetry = variant === 'both' && canRetryTx(record)

  // Nothing to show on completed records — no Cancel (already done), no Retry (lifecycle finished).
  if (!isInFlight && !canRetry) return null

  const broadcasted = hasBroadcast(record)
  const stopLabel = broadcasted ? 'Stop tracking' : 'Cancel'
  // Confirm before dismissing — the user is intentionally stopping us from watching an on-chain
  // tx that will still run regardless. A bare click on the same place that previously meant
  // "true cancel" should NOT silently drop us into the dismissed state.
  const onStopClick = () => {
    if (broadcasted) {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('Your transaction is already on chain and will continue. We will stop watching it — you can find it on the block explorer using the link in the error view.')
        : true
      if (!ok) return
      dismissTx(record.id)
    } else {
      cancelTx(record.id)
    }
  }

  return (
    <div className={styles.row}>
      {isInFlight ? (
        <Button
          variant="secondary"
          size="sm"
          showIcon={false}
          label={stopLabel}
          onClick={onStopClick}
        />
      ) : null}
      {canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          showIcon={false}
          label="Retry"
          onClick={() => retryTx(record.id)}
        />
      ) : null}
    </div>
  )
}
