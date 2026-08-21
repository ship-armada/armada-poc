// ABOUTME: Tests for resolveFreshQuote — always refetches; flags feeChanged only when the fresh fee differs from the reviewed one.

import { describe, it, expect, vi } from 'vitest'
import { resolveFreshQuote } from './submitQuote'
import type { FeeSchedule } from '@/lib/relayer'

function quote(cacheId: string, transfer: string): FeeSchedule {
  return {
    cacheId,
    expiresAt: 0,
    chainId: 31337,
    broadcasterShieldedAddress: '0zk',
    fees: {
      transfer,
      unshield: '0',
      crossContract: '0',
      crossChainShield: '0',
      crossChainUnshield: '0',
      shield: '0',
      shieldXchain: '0',
    },
  } as unknown as FeeSchedule
}

const feeOf = (s: FeeSchedule) => BigInt(s.fees.transfer)

describe('resolveFreshQuote', () => {
  it('same fee → not changed (submit with the fresh cacheId)', async () => {
    const refresh = vi.fn(async () => quote('fresh-cache', '100'))
    const result = await resolveFreshQuote({ refresh, reviewedFee: 100n, feeOf })
    expect(refresh).toHaveBeenCalledOnce()
    expect(result.feeChanged).toBe(false)
    expect(result.quote?.cacheId).toBe('fresh-cache') // fresh cacheId even when the fee is identical
  })

  it('different fee → changed (caller re-reviews)', async () => {
    const refresh = vi.fn(async () => quote('fresh-cache', '250'))
    const result = await resolveFreshQuote({ refresh, reviewedFee: 100n, feeOf })
    expect(result.feeChanged).toBe(true)
    expect(result.quote?.cacheId).toBe('fresh-cache')
  })

  it('relayer unreachable (null) → quote null, not changed', async () => {
    const refresh = vi.fn(async () => null)
    const result = await resolveFreshQuote({ refresh, reviewedFee: 100n, feeOf })
    expect(result.quote).toBeNull()
    expect(result.feeChanged).toBe(false)
  })
})
