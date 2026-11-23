// ABOUTME: Tests for the committer's useParticipants hook: claim status derived from settlement events.
// ABOUTME: Covers both refund paths, claim() (Allocated) and claimRefund() (RefundClaimed).

import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useParticipants } from './useParticipants'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

const ADDR_A = '0x1111111111111111111111111111111111111111'

function makeEvent(type: string, args: Record<string, unknown>, blockNumber = 1, logIndex = 0): CrowdfundEvent {
  return {
    type: type as CrowdfundEvent['type'],
    args,
    blockNumber,
    logIndex,
    transactionHash: `0x${'ab'.repeat(32)}`,
  }
}

const seededAndCommitted: CrowdfundEvent[] = [
  makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
  makeEvent('Committed', { participant: ADDR_A, hop: 0, amount: 100_000n * 10n ** 6n }, 2, 0),
]

describe('useParticipants claim status', () => {
  // WHY: in a successful sale claim() pays the ARM and the refund in one transaction and emits only
  // Allocated, so an Allocated event means the refund was paid too (the Details table showed
  // "Refund ✗" for a refund that had been paid).
  it('marks the refund claimed when claim() paid it with the ARM', () => {
    const events = [
      ...seededAndCommitted,
      makeEvent('Allocated', { participant: ADDR_A, armTransferred: 83_333n * 10n ** 18n, refundUsdc: 16_667n * 10n ** 6n, delegate: ADDR_A }, 3, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].armClaimed).toBe(true)
    expect(result.current[0].refundUsdc).toBe(16_667n * 10n ** 6n)
    expect(result.current[0].refundClaimed).toBe(true)
  })

  // WHY: in refund mode or after a cancel the refund is paid by claimRefund(), which emits RefundClaimed.
  it('marks the refund claimed from a RefundClaimed event', () => {
    const events = [
      ...seededAndCommitted,
      makeEvent('RefundClaimed', { participant: ADDR_A, usdcAmount: 100_000n * 10n ** 6n }, 3, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].armClaimed).toBe(false)
    expect(result.current[0].refundClaimed).toBe(true)
  })

  it('shows nothing claimed before any claim', () => {
    const { result } = renderHook(() => useParticipants(seededAndCommitted))
    expect(result.current[0].armClaimed).toBe(false)
    expect(result.current[0].refundClaimed).toBe(false)
  })
})
