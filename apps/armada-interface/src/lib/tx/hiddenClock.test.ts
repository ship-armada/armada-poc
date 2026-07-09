// ABOUTME: Tests for the hidden-clock — per-record crediting of tab-hidden time against the budget (T-M5/S-M6).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  markHidden,
  markVisible,
  beginHiddenCredit,
  endHiddenCredit,
  hiddenMsForRecord,
  __resetHiddenClock,
} from './hiddenClock'

beforeEach(() => __resetHiddenClock())

describe('hiddenClock (T-M5/S-M6)', () => {
  it('credits a record for hidden time that elapses during its life', () => {
    beginHiddenCredit('tx-1', 1_000)
    markHidden(2_000)
    markVisible(5_000) // hidden 3s
    expect(hiddenMsForRecord('tx-1', 6_000)).toBe(3_000)
  })

  it('counts the in-progress hidden span (not yet ended)', () => {
    beginHiddenCredit('tx-1', 0)
    markHidden(1_000)
    // still hidden at now=4_000 → 3s and counting
    expect(hiddenMsForRecord('tx-1', 4_000)).toBe(3_000)
  })

  it('does NOT credit hidden time that elapsed BEFORE the record was tracked', () => {
    markHidden(0)
    markVisible(10_000) // 10s hidden, before tx-1 exists
    beginHiddenCredit('tx-1', 11_000)
    markHidden(12_000)
    markVisible(13_000) // 1s hidden during tx-1's life
    expect(hiddenMsForRecord('tx-1', 14_000)).toBe(1_000)
  })

  it('returns 0 for an untracked record (graceful degrade)', () => {
    markHidden(0)
    markVisible(5_000)
    expect(hiddenMsForRecord('never-tracked', 6_000)).toBe(0)
  })

  it('is idempotent on repeated markHidden and frees on endHiddenCredit', () => {
    beginHiddenCredit('tx-1', 0)
    markHidden(1_000)
    markHidden(2_000) // ignored — already hidden since 1_000
    markVisible(4_000) // 3s hidden
    expect(hiddenMsForRecord('tx-1', 5_000)).toBe(3_000)
    endHiddenCredit('tx-1')
    expect(hiddenMsForRecord('tx-1', 5_000)).toBe(0)
  })
})
