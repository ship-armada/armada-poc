// ABOUTME: Resolves DisplayFees for action modals — on-chain shield protocol fee + native gas estimate.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useReadContract } from 'wagmi'
import { getIntegratorAddress, getNetworkConfig } from '@/config/network'
import { loadFeeModuleAddress } from '@/config/deployments'
import { feeModuleAbi } from '@/lib/fees/feeModuleAbi'
import {
  computeDisplayFees,
  type DisplayFees,
} from '@/lib/fees/displayFees'
import type { FeeSchedule } from '@/lib/relayer'
import type { TxKind } from '@/lib/tx/types'
import { useNativeGasEstimate } from './useNativeGasEstimate'

const FEE_MODULE_QUERY_KEY = ['fee-module-address'] as const

export function useDisplayFees(
  kind: TxKind,
  amount: bigint,
  gasChainId: number,
  quote: FeeSchedule | null,
): { fees: DisplayFees; isLoading: boolean } {
  const hubChainId = getNetworkConfig().hub.chainId
  const integrator = getIntegratorAddress()

  const { data: feeModuleAddress } = useQuery({
    queryKey: FEE_MODULE_QUERY_KEY,
    queryFn: loadFeeModuleAddress,
    staleTime: Infinity,
  })

  const needsOnChainShieldFee = kind === 'shield' && amount > 0n && Boolean(feeModuleAddress)

  const { data: shieldFeeResult, isLoading: shieldFeeLoading } = useReadContract({
    address: feeModuleAddress ?? undefined,
    abi: feeModuleAbi,
    functionName: 'calculateShieldFee',
    args: [integrator, amount],
    chainId: hubChainId,
    query: { enabled: needsOnChainShieldFee },
  })

  const nativeGas = useNativeGasEstimate(gasChainId, kind)

  const fees = useMemo(() => {
    const base = computeDisplayFees(kind, amount, quote)
    let protocolFee = base.protocolFee
    if (kind === 'shield' && shieldFeeResult) {
      protocolFee = shieldFeeResult[2]
    } else if (kind === 'shield' && feeModuleAddress && amount > 0n && !shieldFeeResult) {
      // Fallback while loading: ~50 bps default matches deployed fee module baseArmadaTakeBps
      protocolFee = (amount * 50n) / 10_000n
    }
    const feeInclusive =
      kind === 'shield' || kind === 'shield-xchain' || kind === 'unshield-xchain'
    return {
      protocolFee,
      gasFee: 0n,
      nativeGas,
      totalFee: protocolFee,
      feeInclusive,
    }
  }, [kind, amount, quote, shieldFeeResult, feeModuleAddress, nativeGas])

  const isLoading = needsOnChainShieldFee && shieldFeeLoading

  return { fees, isLoading }
}

/** Net USDC credited after inclusive protocol fees (deposit / CCTP). */
export function netAmountAfterFees(amount: bigint, fees: DisplayFees): bigint {
  return amount > fees.protocolFee ? amount - fees.protocolFee : 0n
}

/** Max amount the user can enter in the amount field. */
export function maxSpendableAmount(balance: bigint, fees: DisplayFees): bigint {
  if (fees.feeInclusive) return balance
  return balance > fees.totalFee ? balance - fees.totalFee : 0n
}
