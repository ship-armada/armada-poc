// ABOUTME: Inline transaction status pipeline shown in the final step of a checkout flow.
// ABOUTME: One row per tx — idle / pending / submitted / confirmed / error — with hash + error.

import type { ReactNode } from 'react'
import { Check, Circle, Loader2, X } from 'lucide-react'
import { cn } from '../lib/utils.js'

/**
 * Status states mirror what `useTransactionFlow` exposes:
 *  - `idle`       — not yet started; rendered as a dim circle
 *  - `pending`    — waiting on signature in the wallet
 *  - `submitted`  — broadcast, waiting on confirmation
 *  - `confirmed`  — included on chain successfully
 *  - `error`      — reverted or wallet-rejected
 */
export type TxPipelineStatus =
  | 'idle'
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'error'

export interface TxPipelineRow {
  id: string
  /** User-facing label (e.g. "Approve USDC", "Commit at Hop 1"). */
  label: string
  status: TxPipelineStatus
  txHash?: string | null
  errorMessage?: string | null
  /** Optional explorer URL builder; if provided the hash links out. */
  explorerUrl?: (hash: string) => string
  /** Optional secondary detail line (e.g. "$10,000 USDC"). */
  detail?: ReactNode
}

export interface TxStatusPipelineProps {
  rows: TxPipelineRow[]
  className?: string
  /** Optional heading rendered above the rows. */
  title?: ReactNode
}

function statusCopy(status: TxPipelineStatus, errorMessage?: string | null) {
  switch (status) {
    case 'pending':
      return 'Waiting for wallet signature…'
    case 'submitted':
      return 'Submitted — waiting for confirmation…'
    case 'confirmed':
      return 'Confirmed'
    case 'error':
      return errorMessage ?? 'Failed'
    case 'idle':
    default:
      return 'Pending'
  }
}

function StatusIcon({ status }: { status: TxPipelineStatus }) {
  if (status === 'confirmed')
    return <Check className="size-4 text-success" aria-hidden="true" />
  if (status === 'error')
    return <X className="size-4 text-destructive" aria-hidden="true" />
  if (status === 'pending' || status === 'submitted')
    return <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
  return <Circle className="size-3.5 text-muted-foreground/50" aria-hidden="true" />
}

/** Truncate a 0x-prefixed tx hash for inline display. */
function shortHash(hash: string): string {
  if (hash.length <= 14) return hash
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

export function TxStatusPipeline({ rows, className, title }: TxStatusPipelineProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {title && (
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
      )}
      <ol className="space-y-2" role="list">
        {rows.map((row) => (
          <li
            key={row.id}
            className={cn(
              'flex items-start gap-3 rounded-md border border-border/60 bg-card/40 p-3',
              row.status === 'confirmed' && 'border-success/40 bg-success/5',
              row.status === 'error' && 'border-destructive/40 bg-destructive/5',
            )}
            aria-live={row.status === 'pending' || row.status === 'submitted' ? 'polite' : undefined}
          >
            <span className="mt-0.5 flex size-5 items-center justify-center">
              <StatusIcon status={row.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-medium text-foreground">{row.label}</div>
                {row.detail && (
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {row.detail}
                  </div>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {statusCopy(row.status, row.errorMessage)}
              </div>
              {row.txHash &&
                (row.explorerUrl ? (
                  <a
                    href={row.explorerUrl(row.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {shortHash(row.txHash)}
                  </a>
                ) : (
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {shortHash(row.txHash)}
                  </div>
                ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
