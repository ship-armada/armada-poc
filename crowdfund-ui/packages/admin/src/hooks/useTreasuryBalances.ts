// ABOUTME: Reads ERC-20 balances for USDC and ARM at contract and treasury addresses.
// ABOUTME: Polls every 30 seconds for treasury monitoring.

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { ERC20_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

export interface TreasuryBalances {
  contractArmBalance: bigint
  contractUsdcBalance: bigint
  treasuryArmBalance: bigint
  treasuryUsdcBalance: bigint
  loading: boolean
}

const INITIAL: TreasuryBalances = {
  contractArmBalance: 0n,
  contractUsdcBalance: 0n,
  treasuryArmBalance: 0n,
  treasuryUsdcBalance: 0n,
  loading: true,
}

export function useTreasuryBalances(
  provider: JsonRpcProvider | null,
  crowdfundAddress: string | null,
  treasuryAddress: string | null,
  usdcAddress: string | null,
  armTokenAddress: string | null,
): TreasuryBalances {
  const [state, setState] = useState<TreasuryBalances>(INITIAL)

  const refresh = useCallback(async () => {
    if (!provider || !crowdfundAddress || !treasuryAddress || !usdcAddress || !armTokenAddress) {
      setState((prev) => ({ ...prev, loading: false }))
      return
    }

    try {
      const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, provider)
      const arm = new Contract(armTokenAddress, ERC20_ABI_FRAGMENTS, provider)

      const [contractUsdc, contractArm, treasuryUsdc, treasuryArm] = await Promise.all([
        usdc.balanceOf(crowdfundAddress) as Promise<bigint>,
        arm.balanceOf(crowdfundAddress) as Promise<bigint>,
        usdc.balanceOf(treasuryAddress) as Promise<bigint>,
        arm.balanceOf(treasuryAddress) as Promise<bigint>,
      ])

      setState({
        contractUsdcBalance: contractUsdc,
        contractArmBalance: contractArm,
        treasuryUsdcBalance: treasuryUsdc,
        treasuryArmBalance: treasuryArm,
        loading: false,
      })
    } catch {
      setState((prev) => ({ ...prev, loading: false }))
    }
  }, [provider, crowdfundAddress, treasuryAddress, usdcAddress, armTokenAddress])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  return state
}
