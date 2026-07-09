// ABOUTME: Tests for stepperEta (T-L4) — elapsed timer + overdue ("taking longer than usual") past p90.

import { describe, it, expect } from 'vitest'
import { stepperEta, formatElapsed } from './eta'

const EST = { p50: 30_000, p90: 120_000 }

function rec(executionState: string, createdAt: number) {
  return { executionState: executionState as never, createdAt }
}

describe('stepperEta (T-L4)', () => {
  it('shows the p50 hint + elapsed while in flight and within p90', () => {
    const r = stepperEta(rec('waiting', 0), EST, 12_000)
    expect(r.overdue).toBe(false)
    expect(r.label).toMatch(/Usually takes/i)
    expect(r.label).toMatch(/12s elapsed/)
  })

  it('flips to "taking longer than usual" once elapsed passes p90', () => {
    const r = stepperEta(rec('waiting', 0), EST, 130_000) // > 120s p90
    expect(r.overdue).toBe(true)
    expect(r.label).toMatch(/Taking longer than usual/i)
  })

  it('returns an empty label for terminal records (no live ETA)', () => {
    expect(stepperEta(rec('completed', 0), EST, 999_000)).toEqual({ label: '', overdue: false })
    expect(stepperEta(rec('failed', 0), EST, 999_000)).toEqual({ label: '', overdue: false })
  })

  it('never marks overdue when p90 is 0 (kinds with no meaningful duration)', () => {
    const r = stepperEta(rec('active', 0), { p50: 0, p90: 0 }, 999_000)
    expect(r.overdue).toBe(false)
    expect(r.label).toMatch(/elapsed/)
  })

  it('formatElapsed renders s / m / h m', () => {
    expect(formatElapsed(12_000)).toBe('12s')
    expect(formatElapsed(120_000)).toBe('2m')
    expect(formatElapsed(3_900_000)).toBe('1h 5m')
  })
})
