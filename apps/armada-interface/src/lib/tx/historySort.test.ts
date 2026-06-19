// ABOUTME: Tests for historySortTime (T-L3) — terminal rows anchor at createdAt so a recovery-reconciled row doesn't leap above newer activity.
// ABOUTME: In-flight rows use updatedAt so they bubble as their stage advances.

import { describe, it, expect } from 'vitest'
import { historySortTime } from './types'
import type { TxRecord } from './types'

function rec(overrides: Partial<TxRecord>): TxRecord {
  return {
    id: 'x',
    kind: 'shield',
    executionState: 'completed',
    stage: 'hub-confirmed',
    stagesCompleted: [],
    updatedSeq: 1,
    createdAt: 0,
    updatedAt: 0,
    meta: { amount: 1n, feeCacheId: '', fromChainId: 31337 },
    artifacts: {},
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rw-1', sourceChainId: 31337 },
    ...overrides,
  } as TxRecord
}

describe('historySortTime (T-L3)', () => {
  it('uses createdAt for a terminal record (ignores a bumped updatedAt)', () => {
    const r = rec({ executionState: 'completed', createdAt: 1_000, updatedAt: 9_999 })
    expect(historySortTime(r)).toBe(1_000)
  })

  it('uses updatedAt for an in-flight record so it bubbles as it progresses', () => {
    const r = rec({ executionState: 'waiting', createdAt: 1_000, updatedAt: 5_000 })
    expect(historySortTime(r)).toBe(5_000)
  })

  it('keeps a recovery-reconciled old terminal row below a newer terminal row', () => {
    // Old shield (createdAt last week) re-confirmed by history recovery just now (updatedAt = now).
    const reconciledOld = rec({ id: 'old', executionState: 'completed', createdAt: 1_000, updatedAt: 100_000 })
    // A genuinely newer completed tx.
    const newer = rec({ id: 'new', executionState: 'completed', createdAt: 50_000, updatedAt: 50_000 })
    const sorted = [reconciledOld, newer].sort((a, b) => historySortTime(b) - historySortTime(a))
    expect(sorted.map(r => r.id)).toEqual(['new', 'old'])
  })
})
