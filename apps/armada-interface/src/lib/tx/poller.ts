// ABOUTME: Abortable, jittered, backoff-aware polling loop for non-terminal tx stages.
// ABOUTME: Each TxKind's stage determines which `pollOnce` adapter to use (Iris, RPC receipt, relayer /status, etc.).

import { pollStatus, RelayerError, type StatusResponse } from '../relayer'
import { track, trackError } from '../telemetry'
import { lifecycleFor } from './lifecycles'
import { extractTxError, waitForReceiptOrFail } from './receipt'
import type { TxRecord } from './types'

export interface PollOptions {
  /** Base interval between polls (ms). Default 10s. */
  intervalMs?: number
  /** ±jitter as a fraction of interval (e.g. 0.2 → ±20%). Default 0.2. */
  jitter?: number
  /** Hard cap on total polling duration (ms). Default 30 min. */
  timeoutMs?: number
  /** Exponential backoff multiplier on poll error. Capped at intervalMs * maxBackoffMultiplier. */
  maxBackoffMultiplier?: number
  signal?: AbortSignal
}

export interface PollResult<T> {
  status: 'done' | 'aborted' | 'timeout'
  value?: T
  error?: unknown
}

const DEFAULTS = {
  intervalMs: 10_000,
  jitter: 0.2,
  timeoutMs: 30 * 60_000,
  maxBackoffMultiplier: 6,
} as const

const POLL_BUDGET_FLOOR_MS = 10_000

/**
 * Derive an inner poll timeout from a record's per-kind lifecycle cap minus elapsed wall-clock.
 * Without this, same-chain relayer status polls inherit poller's 30-min default — 3× past their
 * 10-min lifecycle budget, so a wedged relayer pins the flow long after the record should have
 * expired. Floors at 10s so an already-over-budget record fails fast rather than hanging on a
 * single tick, and emits `tx.budget.tight` when the floor engages (sustained signal = records are
 * entering polling with too little budget — usually a resume close to maxDurationMs). (P1-25)
 */
export function pollBudgetMs(record: TxRecord): number {
  const remaining = record.createdAt + lifecycleFor(record.kind).maxDurationMs - Date.now()
  if (remaining < POLL_BUDGET_FLOOR_MS) {
    track('tx.budget.tight', { id: record.id, kind: record.kind, elapsedMs: Date.now() - record.createdAt })
  }
  return Math.max(POLL_BUDGET_FLOOR_MS, remaining)
}

function jittered(base: number, jitter: number): number {
  const delta = base * jitter * (Math.random() * 2 - 1)
  return Math.max(500, base + delta)
}

/**
 * Run `pollOnce` repeatedly until it returns a non-null value, the signal aborts,
 * or the overall `timeoutMs` elapses. Errors from `pollOnce` trigger exponential
 * backoff (intervalMs * 2^n, capped at intervalMs * maxBackoffMultiplier).
 *
 * `pollOnce` MUST honor `signal` so that AbortController cancellation propagates.
 */
export async function poll<T>(
  pollOnce: (signal: AbortSignal) => Promise<T | null>,
  opts: PollOptions = {},
): Promise<PollResult<T>> {
  const o = { ...DEFAULTS, ...opts }
  const startedAt = Date.now()
  let errorStreak = 0

  while (!o.signal?.aborted) {
    let value: T | null = null
    try {
      value = await pollOnce(o.signal ?? new AbortController().signal)
      errorStreak = 0
    } catch (err) {
      errorStreak++
      trackError('poller.tick', err, { errorStreak })
    }

    if (value !== null && value !== undefined) {
      return { status: 'done', value }
    }

    // T-M5: check the budget AFTER a poll attempt, not before. The pre-poll check returned
    // POLL_TIMEOUT without one last look — so a delivery that landed during the previous interval
    // (common when hidden-tab timer throttling stretched it past the budget) surfaced as a false
    // timeout. Polling first means the iteration where the clock runs out still gets a final check.
    if (Date.now() - startedAt > o.timeoutMs) return { status: 'timeout' }

    const baseDelay = errorStreak > 0
      ? Math.min(o.intervalMs * 2 ** Math.min(errorStreak, 6), o.intervalMs * o.maxBackoffMultiplier)
      : o.intervalMs
    const delay = jittered(baseDelay, o.jitter)

    await new Promise<void>((resolve) => {
      // Listener is removed in both branches (timer fires, or abort fires)
      // so long-running polls don't accumulate listeners on the shared signal.
      const onAbort = () => {
        clearTimeout(t)
        o.signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const t = setTimeout(() => {
        o.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      o.signal?.addEventListener('abort', onAbort)
    })
  }

  return { status: 'aborted' }
}

/**
 * `pollOnce` adapter for relayer-mediated submits — fetches `/status/:txHash` once and:
 *   - returns `null` while the relayer reports `pending` (poll loop keeps waiting)
 *   - returns the full `StatusResponse` once the relayer reports `confirmed` or `failed`
 *
 * The poll loop treats any non-null return as terminal, so the caller switches on
 * `result.value.status` to distinguish confirmed (success) from failed (markFailed).
 *
 * Network / 5xx errors from `pollStatus` propagate as throws — the poll loop's exponential backoff
 * + error-streak counter handles transient relayer hiccups.
 *
 * Relayer-404 fallback (P1-25): a 404 means the relayer doesn't know this hash — almost always
 * because it restarted and lost its in-memory status map. The tx is already on chain (we hold its
 * hash), so rather than poll the relayer's memory to a lifecycle timeout, we fall back to the RPC
 * receipt on `fallbackChainId` and translate it into a terminal StatusResponse. 5xx / network
 * errors are NOT treated this way — they rethrow so the poll loop backs off and retries.
 */
export async function pollRelayStatusOnce(
  txHash: string,
  signal: AbortSignal,
  fallbackChainId?: number,
): Promise<StatusResponse | null> {
  try {
    const status = await pollStatus(txHash, signal)
    return status.status === 'pending' ? null : status
  } catch (err) {
    if (!(err instanceof RelayerError) || err.httpStatus !== 404) throw err
    try {
      await waitForReceiptOrFail({ hash: txHash as `0x${string}`, signal, chainId: fallbackChainId })
      return { status: 'confirmed' }
    } catch (receiptErr) {
      const tx = extractTxError(receiptErr)
      if (tx?.code === 'TX_REVERTED') return { status: 'failed', error: tx.message }
      throw receiptErr // POLL_TIMEOUT / RPC error — let the poll loop back off and retry
    }
  }
}
