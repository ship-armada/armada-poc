// ABOUTME: Single renderer for any TxKind's lifecycle — vertical stage list + StatusChip + technical-details disclosure.
// ABOUTME: Reads lifecycleFor(record.kind) + record.{stage,stagesCompleted,executionState} + record.artifacts to drive every row.

import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { TxStatusChip } from './TxStatusChip'
import { stageCopy } from './stageCopy'
import { TechnicalDetailsDisclosure } from '../ui/TechnicalDetailsDisclosure'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import { stepperEta } from '@/lib/tx/eta'
import { nowAtom } from '@/state/time'
import { getChainById, getNetworkConfig } from '@/config/network'
import type { TxRecord, TxExecutionState } from '@/lib/tx/types'
import styles from './TxLifecycleStepper.module.css'

export interface TxLifecycleStepperProps {
  record: TxRecord
  /** Whether the technical-details disclosure starts open. Wired to user preference at the page level. */
  technicalDetailsDefaultOpen?: boolean
  className?: string
}

type RowKind = 'done' | 'current-active' | 'current-waiting' | 'current-failed' | 'pending'

function rowKindFor(
  stage: string,
  currentStage: string,
  stagesCompleted: ReadonlyArray<string>,
  executionState: TxExecutionState,
): RowKind {
  if (stagesCompleted.includes(stage)) return 'done'
  if (stage !== currentStage) return 'pending'
  if (executionState === 'completed') return 'done'
  if (executionState === 'failed') return 'current-failed'
  if (executionState === 'waiting') return 'current-waiting'
  return 'current-active'
}

function RowIcon({ kind }: { kind: RowKind }) {
  switch (kind) {
    case 'done':
      return <CheckCircle2 className={styles.iconDone} size={20} aria-hidden="true" />
    case 'current-failed':
      return <XCircle className={styles.iconFailed} size={20} aria-hidden="true" />
    case 'current-active':
    case 'current-waiting':
      return <Loader2 className={`${styles.iconActive} animate-spin`} size={20} aria-hidden="true" />
    case 'pending':
      return <Circle className={styles.iconPending} size={20} aria-hidden="true" />
  }
}

function explorerLinkFor(chainId: number, txHash: `0x${string}`): string | null {
  const chain = getChainById(chainId)
  return chain?.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : null
}

export function TxLifecycleStepper({
  record,
  technicalDetailsDefaultOpen = false,
  className,
}: TxLifecycleStepperProps) {
  const lifecycle = lifecycleFor(record.kind)
  const cls = [styles.root, className].filter(Boolean).join(' ')
  // T-L4: live elapsed timer + "taking longer than usual" past p90. `nowAtom` ticks every 60s
  // (useNowTicker at App root), so the label refreshes while the stepper is mounted.
  const now = useAtomValue(nowAtom)
  const eta = stepperEta(record, lifecycle.estDuration, now)

  return (
    <div className={cls}>
      <header className={styles.header}>
        <TxStatusChip state={record.executionState} error={record.artifacts.error ?? null} />
        {eta.label ? (
          <span className={[styles.eta, eta.overdue ? styles.etaOverdue : ''].filter(Boolean).join(' ')}>
            {eta.label}
          </span>
        ) : null}
      </header>

      <ol className={styles.stages}>
        {lifecycle.stages.map(stage => {
          const kind = rowKindFor(
            stage as string,
            record.stage as string,
            record.stagesCompleted as ReadonlyArray<string>,
            record.executionState,
          )
          const isCurrent = kind.startsWith('current')
          const copy = stageCopy(
            record.kind,
            stage as string,
            isCurrent ? record.executionState : undefined,
          )
          // Only show the proof-progress bar on the active build-proof row. Other stages don't
          // carry a meaningful percentage; the lifecycle stepper handles its own visual progress.
          const showProgress =
            isCurrent
            && stage === 'build-proof'
            && typeof record.artifacts.proofProgress === 'number'
          const progressPct = showProgress
            ? Math.round((record.artifacts.proofProgress ?? 0) * 100)
            : 0
          return (
            <li
              key={stage as string}
              className={[styles.row, styles[kind]].filter(Boolean).join(' ')}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className={styles.iconCell}>
                <RowIcon kind={kind} />
              </span>
              <span className={styles.labelCol}>
                <span className={styles.label}>
                  {copy}
                  {showProgress ? <span className={styles.progressPct}> · {progressPct}%</span> : null}
                </span>
                {showProgress ? (
                  <span
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Proof generation progress"
                  >
                    <span
                      className={styles.progressFill}
                      style={{ width: `${progressPct}%` }}
                    />
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      <TechnicalDetailsDisclosure defaultOpen={technicalDetailsDefaultOpen}>
        <dl className={styles.facts}>
          <div>
            <dt>Record id</dt>
            <dd>{record.id}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{record.kind}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{record.stage}</dd>
          </div>
          <div>
            <dt>Execution state</dt>
            <dd>{record.executionState}</dd>
          </div>
          {record.artifacts.sourceTxHash ? (
            <div>
              <dt>Source tx</dt>
              <dd>
                <TxLink
                  hash={record.artifacts.sourceTxHash}
                  chainId={record.walletContext.sourceChainId}
                />
              </dd>
            </div>
          ) : null}
          {'messageHash' in record.artifacts && record.artifacts.messageHash ? (
            <div>
              <dt>Iris message</dt>
              <dd className={styles.hash}>{record.artifacts.messageHash}</dd>
            </div>
          ) : null}
          {'destTxHash' in record.artifacts && record.artifacts.destTxHash ? (
            <div>
              <dt>Destination tx</dt>
              <dd>
                <TxLink
                  hash={record.artifacts.destTxHash}
                  chainId={destinationChainIdFor(record) ?? record.walletContext.sourceChainId}
                />
              </dd>
            </div>
          ) : null}
          {record.artifacts.error ? (
            <div>
              <dt>Error</dt>
              <dd className={styles.error}>
                <span className={styles.errorCode}>{record.artifacts.error.code}</span>
                {' '}
                {record.artifacts.error.message}
              </dd>
            </div>
          ) : null}
        </dl>
      </TechnicalDetailsDisclosure>
    </div>
  )
}

function TxLink({ hash, chainId }: { hash: `0x${string}`; chainId: number }) {
  const href = explorerLinkFor(chainId, hash)
  if (!href) {
    return <span className={styles.hash}>{hash}</span>
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={styles.link}>
      {hash}
    </a>
  )
}

/**
 * Which chain the `destTxHash` lives on, so its explorer link points to the right chain (T-L5).
 * `unshield-xchain` delivers to `meta.toChainId`; `shield-xchain` mints on the HUB (its burn is on
 * the client chain). Without the shield-xchain case the link fell back to the SOURCE chain — a dead
 * link. Exported for unit testing.
 */
export function destinationChainIdFor(record: TxRecord): number | undefined {
  if (record.kind === 'shield-xchain') {
    return getNetworkConfig().hub.chainId
  }
  if (record.kind === 'unshield-xchain') {
    return (record.meta as { toChainId?: number }).toChainId
  }
  return undefined
}
