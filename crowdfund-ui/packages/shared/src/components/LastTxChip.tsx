// ABOUTME: Compact chip in the AppShell header showing the latest transaction state.
// ABOUTME: Click opens a Popover with the full label, explorer link, and error (if any).

import { useAtomValue, useSetAtom } from 'jotai'
import { CheckCircle2, CircleDashed, Copy, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { lastTxAtom, type LastTx, type LastTxStatus } from '../hooks/useTxToast.js'
import { Button } from './ui/button.js'
import { CopyToast } from './CopyToast.js'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover.js'

function StatusIcon({ status, className }: { status: LastTxStatus; className?: string }) {
  const cls = className ?? 'size-3.5'
  if (status === 'pending') return <Loader2 className={`${cls} animate-spin text-status-pending`} />
  if (status === 'submitted') return <CircleDashed className={`${cls} animate-spin text-status-submitted`} />
  if (status === 'confirmed') return <CheckCircle2 className={`${cls} text-status-confirmed`} />
  return <XCircle className={`${cls} text-status-failed`} />
}

function statusLabel(status: LastTxStatus): string {
  if (status === 'pending') return 'Waiting for wallet'
  if (status === 'submitted') return 'Submitted — pending confirmation'
  if (status === 'confirmed') return 'Confirmed'
  return 'Failed'
}

function shortHash(hash: string | null): string {
  if (!hash) return '—'
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`
}

export interface LastTxChipProps {
  /** When provided, the chip renders from this value instead of `lastTxAtom`,
   *  letting a caller drive it from its own source (e.g. a multi-tx pipeline
   *  store). The Dismiss control is hidden in this mode — the source manages
   *  the chip's lifecycle. */
  override?: LastTx | null
}

export function LastTxChip({ override }: LastTxChipProps = {}) {
  const atomTx = useAtomValue(lastTxAtom)
  const setLastTx = useSetAtom(lastTxAtom)
  const usingOverride = override !== undefined
  const lastTx = usingOverride ? override : atomTx
  if (!lastTx) return null

  const hashDisplay = shortHash(lastTx.hash)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-2 px-2"
          aria-label={`Last transaction: ${statusLabel(lastTx.status)}`}
        >
          <StatusIcon status={lastTx.status} />
          <span className="">{hashDisplay}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusIcon status={lastTx.status} className="size-4" />
            <span className="">{statusLabel(lastTx.status)}</span>
          </div>
          <div className="text-muted-foreground">{lastTx.label}</div>
          {lastTx.hash && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Hash</span>
              <div className="flex items-center gap-1">
                {lastTx.explorerUrl ? (
                  <a
                    href={`${lastTx.explorerUrl}/tx/${lastTx.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {hashDisplay}
                  </a>
                ) : (
                  <span className="">{hashDisplay}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Copy transaction hash"
                  className="h-auto p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    navigator.clipboard.writeText(lastTx.hash!).then(
                      () => toast.success(<CopyToast>Hash copied</CopyToast>),
                      () => toast.error('Clipboard write failed'),
                    )
                  }
                >
                  <Copy className="size-3" />
                </Button>
              </div>
            </div>
          )}
          {lastTx.error && (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
              {lastTx.error}
            </div>
          )}
          {!usingOverride && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setLastTx(null)}
            >
              Dismiss
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
