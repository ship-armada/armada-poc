// ABOUTME: USDC allowance checking for the commit flow.
// ABOUTME: Reads current allowance and provides a needsApproval helper.

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { ERC20_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

export interface UseAllowanceResult {
  allowance: bigint
  balance: bigint
  armBalance: bigint
  loading: boolean
  needsApproval: (amount: bigint) => boolean
  refresh: () => Promise<void>
}

export function useAllowance(
  address: string | null,
  usdcAddress: string | null,
  crowdfundAddress: string | null,
  armTokenAddress: string | null,
  provider: JsonRpcProvider | null,
): UseAllowanceResult {
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [balance, setBalance] = useState<bigint>(0n)
  const [armBalance, setArmBalance] = useState<bigint>(0n)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!address || !usdcAddress || !crowdfundAddress || !provider) {
      setLoading(false)
      return
    }

    try {
      const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, provider)
      const queries: Promise<bigint>[] = [
        usdc.allowance(address, crowdfundAddress) as Promise<bigint>,
        usdc.balanceOf(address) as Promise<bigint>,
      ]
      if (armTokenAddress) {
        const arm = new Contract(armTokenAddress, ERC20_ABI_FRAGMENTS, provider)
        queries.push(arm.balanceOf(address) as Promise<bigint>)
      }
      const results = await Promise.all(queries)
      setAllowance(results[0])
      setBalance(results[1])
      if (results[2] !== undefined) setArmBalance(results[2])
    } catch {
      // Non-fatal — will retry on next poll
    } finally {
      setLoading(false)
    }
  }, [address, usdcAddress, crowdfundAddress, armTokenAddress, provider])

  useEffect(() => {
    refresh()
  }, [refresh])

  const needsApproval = useCallback(
    (amount: bigint): boolean => {
      return allowance < amount
    },
    [allowance],
  )

  return { allowance, balance, armBalance, loading, needsApproval, refresh }
}
