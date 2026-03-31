// ABOUTME: Tests for useParticipants hook — event-to-row derivation.
// ABOUTME: Verifies graph building, allocation tracking, and sort order.

import { renderHook } from '@testing-library/react'
import { useParticipants } from './useParticipants'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

const ADDR_A = '0x1111111111111111111111111111111111111111'
const ADDR_B = '0x2222222222222222222222222222222222222222'

function makeEvent(type: string, args: Record<string, unknown>, blockNumber = 1, logIndex = 0): CrowdfundEvent {
  return {
    type: type as CrowdfundEvent['type'],
    args,
    blockNumber,
    logIndex,
    transactionHash: `0x${'ab'.repeat(32)}`,
  }
}

describe('useParticipants', () => {
  it('returns empty array for no events', () => {
    const { result } = renderHook(() => useParticipants([]))
    expect(result.current).toEqual([])
  })

  it('builds rows from SeedAdded and Committed events', () => {
    const events: CrowdfundEvent[] = [
      makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
      makeEvent('Committed', { participant: ADDR_A, hop: 0, amount: 5000n * 10n ** 6n }, 2, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current.length).toBe(1)
    expect(result.current[0].address).toBe(ADDR_A.toLowerCase())
    expect(result.current[0].hop).toBe(0)
    expect(result.current[0].committed).toBe(5000n * 10n ** 6n)
  })

  it('tracks allocations from Allocated events', () => {
    const events: CrowdfundEvent[] = [
      makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
      makeEvent('Committed', { participant: ADDR_A, hop: 0, amount: 5000n * 10n ** 6n }, 2, 0),
      makeEvent('Allocated', { participant: ADDR_A, armTransferred: 4000n * 10n ** 18n, refundUsdc: 1000n * 10n ** 6n, delegate: ADDR_A }, 3, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].allocatedArm).toBe(4000n * 10n ** 18n)
    expect(result.current[0].refundUsdc).toBe(1000n * 10n ** 6n)
  })

  it('tracks RefundClaimed events', () => {
    const events: CrowdfundEvent[] = [
      makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
      makeEvent('Committed', { participant: ADDR_A, hop: 0, amount: 5000n * 10n ** 6n }, 2, 0),
      makeEvent('Allocated', { participant: ADDR_A, armTransferred: 4000n * 10n ** 18n, refundUsdc: 1000n * 10n ** 6n, delegate: ADDR_A }, 3, 0),
      makeEvent('RefundClaimed', { participant: ADDR_A, usdcAmount: 1000n * 10n ** 6n }, 4, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].armClaimed).toBe(true)
    expect(result.current[0].refundClaimed).toBe(true)
  })

  it('sorts rows by committed descending', () => {
    const events: CrowdfundEvent[] = [
      makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
      makeEvent('SeedAdded', { seed: ADDR_B }, 1, 1),
      makeEvent('Committed', { participant: ADDR_A, hop: 0, amount: 1000n * 10n ** 6n }, 2, 0),
      makeEvent('Committed', { participant: ADDR_B, hop: 0, amount: 5000n * 10n ** 6n }, 2, 1),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].address).toBe(ADDR_B.toLowerCase())
    expect(result.current[1].address).toBe(ADDR_A.toLowerCase())
  })

  it('sets null allocation fields when no Allocated event', () => {
    const events: CrowdfundEvent[] = [
      makeEvent('SeedAdded', { seed: ADDR_A }, 1, 0),
    ]
    const { result } = renderHook(() => useParticipants(events))
    expect(result.current[0].allocatedArm).toBeNull()
    expect(result.current[0].refundUsdc).toBeNull()
    expect(result.current[0].armClaimed).toBe(false)
    expect(result.current[0].refundClaimed).toBe(false)
  })
})
