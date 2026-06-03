// ABOUTME: Sentry initialization for the crowdfund committer app.
// ABOUTME: No-op when VITE_SENTRY_DSN is unset so local/dev runs incur no overhead.

import * as Sentry from '@sentry/react'

let initialized = false

/**
 * Parse VITE_SENTRY_TRACES_SAMPLE_RATE into a number in [0, 1]. Anything
 * missing, NaN, or out of range falls back to 0 (tracing disabled).
 */
function getTracesSampleRate(): number {
  const raw = import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE
  if (raw == null || raw === '') return 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0
  return n
}

export function initSentry(): void {
  if (initialized) return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  const tracesSampleRate = getTracesSampleRate()

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE ?? 'production',
    release: import.meta.env.VITE_SENTRY_RELEASE,
    // Performance tracing is opt-in per environment via
    // VITE_SENTRY_TRACES_SAMPLE_RATE (e.g. 0.1 for 10% sampling). Defaults to 0
    // so dev / non-traced prod incurs no per-event tracing cost.
    tracesSampleRate,
    // Only attach the browser-tracing integration when sampling is on. Keeps
    // the runtime instrumentation (fetch/XHR/navigation hooks) off entirely
    // when tracing is disabled, rather than capturing-then-dropping.
    integrations: (defaults) =>
      tracesSampleRate > 0
        ? [...defaults, Sentry.browserTracingIntegration()]
        : defaults,
    // Don't send PII (wallet addresses are sensitive in this context).
    sendDefaultPii: false,
    // Strip query strings from transaction names + request URLs before send.
    // The /invite route carries signed invite payloads (inviter address, sig,
    // nonce, deadline). Even though invite signatures aren't secret, we don't
    // want inviter addresses leaking into Sentry transactions / breadcrumbs.
    beforeSendTransaction(event) {
      if (event.transaction && event.transaction.includes('?')) {
        event.transaction = event.transaction.split('?')[0]
      }
      if (event.request?.url && event.request.url.includes('?')) {
        event.request.url = event.request.url.split('?')[0]
      }
      return event
    },
  })
  initialized = true
}

/**
 * Capture an error originating from a wallet interaction (RainbowKit/wagmi, signature
 * rejection, chain mismatch, etc.) with a `wallet` tag and structured breadcrumb so
 * Sentry filters and the issue triage flow can split wallet errors from contract errors.
 */
export function captureWalletError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.withScope((scope) => {
    scope.setTag('source', 'wallet')
    if (context) scope.setContext('wallet', context as Record<string, unknown>)
    Sentry.captureException(err)
  })
}

/**
 * Capture an error originating from a contract write (revert, gas estimation failure,
 * receipt mismatch, etc.). Tag + breadcrumb mirror the wallet path so triage stays simple.
 */
export function captureContractError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return
  Sentry.withScope((scope) => {
    scope.setTag('source', 'contract')
    if (context) scope.setContext('contract', context as Record<string, unknown>)
    Sentry.captureException(err)
  })
}

export const SentryErrorBoundary = Sentry.ErrorBoundary
