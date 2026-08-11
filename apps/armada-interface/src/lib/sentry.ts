// ABOUTME: Sentry init + capture for @armada/interface — error-only, DSN-gated (no-op without VITE_SENTRY_DSN).
// ABOUTME: A beforeSend scrubber redacts 0zk addresses + long hex so shielded data can't leak to the sink (privacy app).

import * as Sentry from '@sentry/react'

let initialized = false

/**
 * Redact shielded/account identifiers from a string before it leaves the device. Mirrors the
 * leak vectors `lib/telemetry.ts` already guards against by truncating, but applies to the full
 * exception payload Sentry transmits.
 */
export function scrubString(input: string): string {
  return input
    // shielded (0zk) addresses (0zk + bech32-ish payload).
    .replace(/0zk[0-9a-zA-Z]{8,}/g, '0zk[redacted]')
    // EVM addresses (40 hex), tx hashes (64 hex), calldata / key material (any long hex run).
    .replace(/0x[0-9a-fA-F]{40,}/g, '0x[redacted]')
}

function scrubMaybe(v: unknown): unknown {
  return typeof v === 'string' ? scrubString(v) : v
}

/**
 * Sentry `beforeSend` hook. A thrown error's message, stack values, or breadcrumbs can carry 0zk
 * addresses, EVM addresses, tx hashes, or calldata. We scrub everywhere those realistically ride
 * along before the event is transmitted. `sendDefaultPii: false` already strips IP/cookies; this
 * covers the application payload.
 */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.message) event.message = scrubString(event.message)
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value)
  }
  for (const bc of event.breadcrumbs ?? []) {
    if (bc.message) bc.message = scrubString(bc.message)
    if (bc.data) {
      for (const k of Object.keys(bc.data)) bc.data[k] = scrubMaybe(bc.data[k])
    }
  }
  if (event.request?.url) event.request.url = scrubString(event.request.url)
  return event
}

/**
 * Initialise Sentry. No-op unless `VITE_SENTRY_DSN` is set, so local/dev and any build without the
 * env var incur zero overhead and never transmit. Errors only — no performance traces / replay.
 * Call once, before render, from `main.tsx`.
 */
export function initSentry(): void {
  if (initialized) return
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (!dsn) return
  Sentry.init({
    dsn,
    environment:
      (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ??
      import.meta.env.MODE ??
      'production',
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    // Error tracking only — performance/replay incur per-event cost we don't need.
    tracesSampleRate: 0,
    // Privacy app: never attach IP/cookies. The beforeSend scrubber handles the rest.
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  })
  initialized = true
}

/**
 * Capture a caught error. No-op until `initSentry` ran with a DSN. `scope` becomes a Sentry tag;
 * `context` (primitive props) attaches as structured context. The error object is passed through
 * unmodified — redaction happens centrally in `beforeSend`.
 */
export function captureError(
  err: unknown,
  opts?: { scope?: string; context?: Record<string, unknown> },
): void {
  if (!initialized) return
  Sentry.withScope((scope) => {
    if (opts?.scope) scope.setTag('scope', opts.scope)
    if (opts?.context) scope.setContext('detail', opts.context)
    Sentry.captureException(err)
  })
}

/** Test-only — reset the module-scope init flag so each test starts clean. */
export function _resetSentryForTests(): void {
  initialized = false
}
