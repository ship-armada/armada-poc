// ABOUTME: Tests for lib/telemetry trackError — message reduced to first line, capped at 200 chars (P2 hygiene).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { trackError } from './telemetry'

afterEach(() => {
  vi.restoreAllMocks()
})

function capturedMessage(spy: ReturnType<typeof vi.spyOn>): string {
  const line = spy.mock.calls[0]![1] as { message: string }
  return line.message
}

describe('trackError message truncation', () => {
  it('keeps only the first line of a multi-line error message', () => {
    // WHY: SDK/RPC/wallet errors carry long multi-line payloads (request bodies, calldata) that
    // may embed sensitive material. Retaining only the first line bounds what we keep.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    trackError('scope', new Error('first line\nsecond line\nthird'))
    expect(capturedMessage(spy)).toBe('first line')
  })

  it('caps the message at 200 chars with a trailing ellipsis', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    trackError('scope', new Error('x'.repeat(500)))
    const msg = capturedMessage(spy)
    expect(msg.length).toBe(201) // 200 retained chars + the ellipsis
    expect(msg.endsWith('…')).toBe(true)
  })

  it('stringifies non-Error values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    trackError('scope', 'plain string error')
    expect(capturedMessage(spy)).toBe('plain string error')
  })
})
