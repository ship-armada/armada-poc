// ABOUTME: Warns when the connected EVM wallet has low native balance for gas on the action's signing chain.

import { useAccount, useBalance } from 'wagmi'
import { formatEther } from 'viem'

/** ~0.0005 ETH — enough for a few testnet txs; below this we show a warning. */
const MIN_NATIVE_WEI = 500_000_000_000_000n

export interface GasBalanceWarning {
  show: boolean
  nativeSymbol: string
  formattedBalance: string | null
}

export function useGasBalanceWarning(gasChainId: number): GasBalanceWarning {
  const { address, isConnected } = useAccount()
  const { data } = useBalance({
    chainId: gasChainId,
    address,
    query: { enabled: isConnected && Boolean(address) },
  })

  if (!isConnected || !address || data === undefined) {
    return { show: false, nativeSymbol: 'ETH', formattedBalance: null }
  }

  const low = data.value < MIN_NATIVE_WEI
  return {
    show: low,
    nativeSymbol: data.symbol,
    formattedBalance: formatEther(data.value),
  }
}
