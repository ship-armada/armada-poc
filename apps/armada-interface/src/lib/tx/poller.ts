// ABOUTME: Abortable, jittered, backoff-aware polling loop for non-terminal tx stages.
// ABOUTME: Each TxKind's stage determines which `pollOnce` adapter to use (Iris, RPC receipt, relayer /status, etc.).

import { pollStatus, type StatusResponse } from '../relayer'
import { trackError } from '../telemetry'

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
    if (Date.now() - startedAt > o.timeoutMs) return { status: 'timeout' }

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
 * Network/HTTP errors from `pollStatus` propagate as throws — the poll loop's exponential backoff
 * + error-streak counter handles transient relayer hiccups. A wedged status endpoint surfaces as a
 * lifecycle `timeout` rather than a per-tick failure.
 *
 * Dormant in A1 alongside `submitRelay`. Handlers wire it in A3+.
 */
export async function pollRelayStatusOnce(
  txHash: string,
  signal: AbortSignal,
): Promise<StatusResponse | null> {
  const status = await pollStatus(txHash, signal)
  return status.status === 'pending' ? null : status
}
