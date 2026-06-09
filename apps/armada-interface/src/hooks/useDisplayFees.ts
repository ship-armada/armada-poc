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

  // The hub `PrivacyPool.shield()` path runs `_transferTokenIn` which always calls
  // `IArmadaFeeModule.calculateShieldFee` regardless of how the USDC reached hub — so the same
  // 50 bps armadaTake applies whether the user deposited directly on hub (`shield`) or arrived
  // via CCTP from a client chain (`shield-xchain`). The on-chain read must cover both kinds;
  // gating on `shield` alone made the cross-chain Fee row miss the protocol component and
  // surface only the much-smaller CCTP fast-fee ("<0.01 USDC" on a $10 client deposit).
  const isShieldKind = kind === 'shield' || kind === 'shield-xchain'
  const needsOnChainShieldFee = isShieldKind && amount > 0n && Boolean(feeModuleAddress)

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
    if (isShieldKind && shieldFeeResult) {
      protocolFee = shieldFeeResult[2]
    } else if (isShieldKind && feeModuleAddress && amount > 0n && !shieldFeeResult) {
      // Fallback while the on-chain read is loading: ~50 bps matches deployed fee module
      // `baseArmadaTakeBps` so the Fee row doesn't flash a misleading lower value during the
      // brief async window before the wagmi result lands.
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
  }, [kind, amount, quote, shieldFeeResult, feeModuleAddress, isShieldKind, nativeGas])

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
