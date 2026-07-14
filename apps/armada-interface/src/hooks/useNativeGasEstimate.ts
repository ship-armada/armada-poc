// ABOUTME: Estimates native-token gas cost for wallet-submitted txs (display only).

import { useMemo } from 'react'
import { useAccount, useGasPrice } from 'wagmi'
import { formatEther } from 'viem'
import type { NativeGasEstimate } from '@/lib/fees/displayFees'
import type { TxKind } from '@/lib/tx/types'

export type { NativeGasEstimate }

/**
 * Gas units per flow for fee tooltip display. The five same-chain / yield flows are set from measured
 * Sepolia `gasUsed` plus ~10-15% headroom (see issue #331). The two -xchain flows are unmeasured and
 * kept at their prior conservative estimates.
 * TODO(#331): set shield-xchain / unshield-xchain from real Sepolia gasUsed once measured
 * (relayer-side re-tune tracked in ship-armada/armada-relayer#16).
 */
const GAS_UNITS: Partial<Record<TxKind, bigint>> = {
  shield: 1_000_000n,
  'shield-xchain': 600_000n,
  'unshield-local': 1_400_000n,
  'unshield-xchain': 650_000n,
  'transfer-shielded': 1_300_000n,
  'yield-deposit': 2_000_000n,
  'yield-withdraw': 2_000_000n,
}

export function useNativeGasEstimate(
  gasChainId: number,
  kind: TxKind,
): NativeGasEstimate | null {
  const { isConnected } = useAccount()
  const { data: gasPrice } = useGasPrice({
    chainId: gasChainId,
    query: { enabled: isConnected },
  })

  return useMemo(() => {
    const units = GAS_UNITS[kind] ?? 400_000n
    if (!gasPrice) return null
    const wei = units * gasPrice
    const formatted = formatEther(wei)
    const symbol = gasChainId === 11155111 ? 'ETH' : 'ETH'
    return { wei, symbol, formatted }
  }, [gasPrice, gasChainId, kind])
}
