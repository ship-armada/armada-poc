// ABOUTME: Shared DisplayFees fixtures for component tests.

import type { DisplayFees } from '@/lib/fees/displayFees'

export const ZERO_DISPLAY_FEES: DisplayFees = {
  protocolFee: 0n,
  gasFee: 0n,
  nativeGas: null,
  totalFee: 0n,
  feeInclusive: true,
}

export function displayFeesWithProtocol(protocolFee: bigint): DisplayFees {
  return {
    protocolFee,
    gasFee: 0n,
    nativeGas: { wei: 1_000_000_000_000_000n, symbol: 'ETH', formatted: '0.001' },
    totalFee: protocolFee,
    feeInclusive: true,
  }
}

/** @deprecated Use displayFeesWithProtocol */
export function displayFeesWithTotal(totalFee: bigint): DisplayFees {
  return displayFeesWithProtocol(totalFee)
}
