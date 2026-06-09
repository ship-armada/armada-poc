// ABOUTME: Display fee breakdown for action flows — on-chain protocol (USDC) + native gas estimate.
// ABOUTME: Used for amount-card tooltips, review summaries, and max-fill.

import type { FeeSchedule } from '@/lib/relayer'
import { userFeeForKind } from '@/lib/relayer'
import type { TxKind } from '@/lib/tx/types'

export interface NativeGasEstimate {
  wei: bigint
  symbol: string
  formatted: string
}

export interface DisplayFees {
  /** USDC protocol fee (shield fee module or CCTP bps) — deducted from deposit amount when inclusive. */
  protocolFee: bigint
  /** @deprecated Use nativeGas — kept 0 for wallet-submitted flows. */
  gasFee: bigint
  /** Estimated network gas paid in native token from the user's wallet. */
  nativeGas: NativeGasEstimate | null
  /** USDC fees shown in the amount-card FEE row (protocol only today). */
  totalFee: bigint
  /** When true, fee is taken from the entered amount; max spend = full balance. */
  feeInclusive: boolean
}

type RelayerFeeKey = keyof FeeSchedule['fees']

export function relayerFeeKeyForKind(kind: TxKind): RelayerFeeKey {
  switch (kind) {
    case 'shield-xchain':
      return 'crossChainShield'
    case 'unshield-xchain':
      return 'crossChainUnshield'
    case 'shield':
    case 'yield-deposit':
    case 'yield-withdraw':
      return 'crossContract'
    case 'unshield-local':
      return 'unshield'
    case 'transfer-shielded':
      return 'transfer'
    case 'transfer-shielded-received':
      // Synthetic received-transfer records are reconstructed from chain and never submitted, so
      // they carry no relayer fee. Reaching here means a received record was fed into fee logic —
      // a caller bug. Throw rather than invent a fee key.
      throw new Error('relayerFeeKeyForKind: received transfers carry no relayer fee')
  }
}

/** Relayer USDC reimbursement — not charged to users until submitRelay ships. */
export function relayerGasFeeForKind(_kind: TxKind, _quote: FeeSchedule | null): bigint {
  return 0n
}

/** Base display fees; shield protocol fee is overridden in useDisplayFees via fee module. */
export function computeDisplayFees(
  kind: TxKind,
  amount: bigint,
  _quote: FeeSchedule | null,
): DisplayFees {
  const protocolFee = userFeeForKind(kind, amount)
  const feeInclusive =
    kind === 'shield' || kind === 'shield-xchain' || kind === 'unshield-xchain'
  return {
    protocolFee,
    gasFee: 0n,
    nativeGas: null,
    totalFee: protocolFee,
    feeInclusive,
  }
}

/** @deprecated Use maxSpendableAmount from useDisplayFees.ts */
export function maxInputAmount(balance: bigint, totalFee: bigint): bigint {
  return balance > totalFee ? balance - totalFee : 0n
}
