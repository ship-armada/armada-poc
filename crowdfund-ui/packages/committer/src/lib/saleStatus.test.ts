// ABOUTME: Unit tests for the Progress card's sale status pill and the pre-open window check.
// ABOUTME: Before windowStart the sale reads "OPENS SOON", never "CLOSED".
import { describe, it, expect } from 'vitest'
import { formatSaleStatusLabel, isPreOpen } from './saleStatus'

const WINDOW_START = 1_750_000_000

describe('isPreOpen', () => {
  it('is true for an active sale before windowStart', () => {
    expect(isPreOpen(0, WINDOW_START, WINDOW_START - 1)).toBe(true)
  })

  it('is false once the window has opened', () => {
    expect(isPreOpen(0, WINDOW_START, WINDOW_START)).toBe(false)
  })

  it('is false for a cancelled sale, even before windowStart', () => {
    expect(isPreOpen(2, WINDOW_START, WINDOW_START - 1)).toBe(false)
  })

  it('is false until the window and block timestamp have loaded', () => {
    expect(isPreOpen(0, 0, WINDOW_START - 1)).toBe(false)
    expect(isPreOpen(0, WINDOW_START, 0)).toBe(false)
  })
})

describe('formatSaleStatusLabel', () => {
  it('reads OPENS SOON before the window opens', () => {
    expect(formatSaleStatusLabel(0, false, true)).toEqual({ label: 'OPENS SOON', dot: 'lavender' })
  })

  it('reads ACTIVE while the window is open', () => {
    expect(formatSaleStatusLabel(0, true, false)).toEqual({ label: 'ACTIVE', dot: 'active' })
  })

  it('reads CLOSED after the window ends but before finalization', () => {
    expect(formatSaleStatusLabel(0, false, false)).toEqual({ label: 'CLOSED', dot: 'neutral' })
  })

  it('reads FINALIZED / CANCELLED once the launch team rules', () => {
    expect(formatSaleStatusLabel(1, false, false)).toEqual({ label: 'FINALIZED', dot: 'lavender' })
    expect(formatSaleStatusLabel(2, false, false)).toEqual({ label: 'CANCELLED', dot: 'warning' })
  })
})
