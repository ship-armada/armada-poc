// ABOUTME: Tests for lib/sentry — DSN-gated init, error-only config, and the beforeSend scrubber
// ABOUTME: that redacts 0zk / EVM addresses + long hex so shielded data can't reach the Sentry sink.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@sentry/react', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: { setTag: () => void; setContext: () => void }) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn() }),
  ),
}))

import { init, captureException } from '@sentry/react'
import {
  initSentry,
  captureError,
  scrubString,
  scrubEvent,
  _resetSentryForTests,
} from './sentry'

const mockInit = init as unknown as ReturnType<typeof vi.fn>
const mockCapture = captureException as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  _resetSentryForTests()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('scrubString', () => {
  it('redacts railgun 0zk addresses', () => {
    const addr = '0zk1' + 'q'.repeat(40)
    expect(scrubString(`sent to ${addr} ok`)).toBe('sent to 0zk[redacted] ok')
    expect(scrubString('0zk' + 'a'.repeat(64))).toBe('0zk[redacted]')
  })

  it('redacts long hex (EVM addresses, tx hashes, calldata)', () => {
    expect(scrubString('addr 0x' + 'a'.repeat(40))).toBe('addr 0x[redacted]')
    expect(scrubString('hash 0x' + 'b'.repeat(64))).toBe('hash 0x[redacted]')
  })

  it('leaves short hex / ordinary numbers alone', () => {
    expect(scrubString('chainId 31337, code 0x1234')).toBe('chainId 31337, code 0x1234')
  })
})

describe('scrubEvent', () => {
  it('redacts message, exception values, breadcrumbs, and request url', () => {
    const secret0zk = '0zk' + 'c'.repeat(40)
    const secretHex = '0x' + 'd'.repeat(40)
    const event = {
      message: `failed for ${secret0zk}`,
      exception: { values: [{ value: `revert at ${secretHex}` }] },
      breadcrumbs: [{ message: `posted ${secret0zk}`, data: { to: secretHex, n: 5 } }],
      request: { url: `https://relayer.example/relay?from=${secretHex}` },
    } as unknown as Parameters<typeof scrubEvent>[0]

    const out = scrubEvent(event)
    expect(out.message).toBe('failed for 0zk[redacted]')
    expect(out.exception?.values?.[0]?.value).toBe('revert at 0x[redacted]')
    expect(out.breadcrumbs?.[0]?.message).toBe('posted 0zk[redacted]')
    expect(out.breadcrumbs?.[0]?.data?.to).toBe('0x[redacted]')
    expect(out.breadcrumbs?.[0]?.data?.n).toBe(5) // non-strings pass through
    expect(out.request?.url).toBe('https://relayer.example/relay?from=0x[redacted]')
  })
})

describe('initSentry', () => {
  it('is a no-op when VITE_SENTRY_DSN is unset', () => {
    // Explicitly clear the DSN so the assertion doesn't depend on the developer's ambient env —
    // a local .env.local with VITE_SENTRY_DSN set would otherwise make this fail spuriously.
    vi.stubEnv('VITE_SENTRY_DSN', '')
    initSentry()
    expect(mockInit).not.toHaveBeenCalled()
  })

  it('initialises error-only, no-PII, with the scrubber when a DSN is set', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://abc@o1.ingest.sentry.io/1')
    initSentry()
    expect(mockInit).toHaveBeenCalledTimes(1)
    const cfg = mockInit.mock.calls[0]![0] as Record<string, unknown>
    expect(cfg.dsn).toBe('https://abc@o1.ingest.sentry.io/1')
    expect(cfg.tracesSampleRate).toBe(0)
    expect(cfg.sendDefaultPii).toBe(false)
    expect(cfg.beforeSend).toBe(scrubEvent)
  })

  it('only initialises once', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://abc@o1.ingest.sentry.io/1')
    initSentry()
    initSentry()
    expect(mockInit).toHaveBeenCalledTimes(1)
  })
})

describe('captureError', () => {
  it('is a no-op until Sentry is initialised', () => {
    captureError(new Error('boom'))
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it('captures the exception once initialised', () => {
    vi.stubEnv('VITE_SENTRY_DSN', 'https://abc@o1.ingest.sentry.io/1')
    initSentry()
    captureError(new Error('boom'), { scope: 'tx', context: { kind: 'shield' } })
    expect(mockCapture).toHaveBeenCalledTimes(1)
    expect(mockCapture).toHaveBeenCalledWith(expect.any(Error))
  })
})
