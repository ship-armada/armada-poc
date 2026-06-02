// ABOUTME: Sentry initialization for the crowdfund committer app.
// ABOUTME: No-op when VITE_SENTRY_DSN is unset so local/dev runs incur no overhead.

import * as Sentry from '@sentry/react'

let initialized = false

export function initSentry(): void {
  if (initialized) return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE ?? 'production',
    release: import.meta.env.VITE_SENTRY_RELEASE,
    // Error tracking only — performance/replay incur per-event cost we don't need.
    tracesSampleRate: 0,
    // Don't send PII (wallet addresses are sensitive in this context).
    sendDefaultPii: false,
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
