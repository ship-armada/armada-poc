import { describe, expect, it } from 'vitest'
import { computeDisplayFees, relayerGasFeeForKind } from './displayFees'
import type { FeeSchedule } from '@/lib/relayer'

const quote: FeeSchedule = {
  cacheId: 'test',
  expiresAt: Date.now() + 60_000,
  chainId: 11155111,
  fees: {
    transfer: '100000',
    unshield: '200000',
    crossContract: '300000',
    crossChainShield: '400000',
    crossChainUnshield: '500000',
  },
}

describe('computeDisplayFees', () => {
  it('shows CCTP protocol fee only for cross-chain shield (native gas separate)', () => {
    // WHY: `computeDisplayFees` is the pure baseline fed into `useDisplayFees`. For
    // `shield-xchain` it surfaces the CCTP fast-fee until `useDisplayFees` overrides with the
    // on-chain `calculateShieldFee` value. The override is what makes the cross-chain Fee row
    // actually match what `ShieldModule._transferTokenIn` deducts on hub — see
    // `apps/armada-interface/src/hooks/useDisplayFees.ts` for the wagmi read that fires for
    // BOTH `shield` and `shield-xchain`.
    const amount = 1_000_000_000n // 1000 USDC
    const fees = computeDisplayFees('shield-xchain', amount, quote)
    expect(fees.protocolFee).toBe(200_000n) // 2 bps
    expect(fees.gasFee).toBe(0n)
    expect(fees.totalFee).toBe(200_000n)
    expect(fees.feeInclusive).toBe(true)
  })

  it('defaults shield to inclusive with zero CCTP until fee module overrides', () => {
    const fees = computeDisplayFees('shield', 5_000_000n, quote)
    expect(fees.protocolFee).toBe(0n)
    expect(fees.totalFee).toBe(0n)
    expect(fees.feeInclusive).toBe(true)
  })
})

describe('relayerGasFeeForKind', () => {
  it('returns 0 without a quote', () => {
    expect(relayerGasFeeForKind('transfer-shielded', null)).toBe(0n)
  })
})
