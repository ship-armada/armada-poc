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
  it('returns zero protocolFee for cross-chain shield until useDisplayFees overrides with calculateShieldFee', () => {
    // WHY: `computeDisplayFees` is the pure baseline fed into `useDisplayFees`. For
    // `shield-xchain` it now reports 0 because the CCTP fast-fee was moved to its own channel
    // (`flowBreakdown.cctpFee`) so the fee-breakdown tooltip can label it "CCTP fee" instead of
    // the previous misleading "Relayer fee". The user-visible protocolFee is the on-chain
    // `IArmadaFeeModule.calculateShieldFee` 50 bps, which `useDisplayFees` overlays via a wagmi
    // `useReadContract` for BOTH `shield` and `shield-xchain` (see
    // `apps/armada-interface/src/hooks/useDisplayFees.ts`).
    const amount = 1_000_000_000n // 1000 USDC
    const fees = computeDisplayFees('shield-xchain', amount, quote)
    expect(fees.protocolFee).toBe(0n)
    expect(fees.gasFee).toBe(0n)
    expect(fees.totalFee).toBe(0n)
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
