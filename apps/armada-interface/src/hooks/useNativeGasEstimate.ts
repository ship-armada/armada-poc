// ABOUTME: Estimates native-token gas cost for wallet-submitted txs (display only).

import { useMemo } from 'react'
import { useAccount, useGasPrice } from 'wagmi'
import { formatEther } from 'viem'
import type { NativeGasEstimate } from '@/lib/fees/displayFees'
import type { TxKind } from '@/lib/tx/types'

export type { NativeGasEstimate }

/**
 * Gas units per flow for fee tooltip display (wallet-submit path — the tx the user actually signs).
 * The five same-chain / yield flows are set from measured Sepolia `gasUsed` + ~10-15% headroom (#331).
 * The two -xchain rows are derived from local gas profiling (test/privacy_pool_gas.ts) corrected to
 * Sepolia. Note `gasUsed` is protocol-deterministic, so local == Sepolia for identical code/state; the
 * only correction is the ~380k Groth16 verify that the profiling test skips under setTestingMode
 * (calibrated from the transact/unshield local-vs-Sepolia deltas: +356k / +402k).
 *   - unshield-xchain signs atomicCrossChainUnshield (real ZK proof + CCTP burn). Local ~902k + the
 *     ~380k verify + CCTP burn + headroom => ~1.5M. Sits just above unshield-local (1.4M), as expected.
 *   - shield-xchain signs only the client-side crossChainShield (USDC pull + CCTP burn, NO proof), so
 *     the verify correction does not apply. Local ~177k; 600k is retained as a conservative ceiling
 *     covering real Circle CCTP overhead. A Sepolia one-shot would let us tighten it.
 */
const GAS_UNITS: Partial<Record<TxKind, bigint>> = {
  shield: 1_000_000n,
  'shield-xchain': 600_000n,
  'unshield-local': 1_400_000n,
  'unshield-xchain': 1_500_000n,
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
