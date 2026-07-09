// ABOUTME: Estimates native-token gas cost for wallet-submitted txs (display only).

import { useMemo } from 'react'
import { useAccount, useGasPrice } from 'wagmi'
import { formatEther } from 'viem'
import type { NativeGasEstimate } from '@/lib/fees/displayFees'
import type { TxKind } from '@/lib/tx/types'

export type { NativeGasEstimate }

/** Conservative gas units per flow for fee tooltip display. */
const GAS_UNITS: Partial<Record<TxKind, bigint>> = {
  shield: 450_000n,
  'shield-xchain': 600_000n,
  'unshield-local': 550_000n,
  'unshield-xchain': 650_000n,
  'transfer-shielded': 550_000n,
  'yield-deposit': 500_000n,
  'yield-withdraw': 500_000n,
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
