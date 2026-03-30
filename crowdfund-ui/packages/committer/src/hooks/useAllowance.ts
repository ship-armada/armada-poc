// ABOUTME: USDC allowance checking for the commit flow.
// ABOUTME: Reads current allowance and provides a needsApproval helper.

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { ERC20_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

export interface UseAllowanceResult {
  allowance: bigint
  balance: bigint
  loading: boolean
  needsApproval: (amount: bigint) => boolean
  refresh: () => Promise<void>
}

export function useAllowance(
  address: string | null,
  usdcAddress: string | null,
  crowdfundAddress: string | null,
  provider: JsonRpcProvider | null,
): UseAllowanceResult {
  const [allowance, setAllowance] = useState<bigint>(0n)
  const [balance, setBalance] = useState<bigint>(0n)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!address || !usdcAddress || !crowdfundAddress || !provider) {
      setLoading(false)
      return
    }

    try {
      const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, provider)
      const [allowanceResult, balanceResult] = await Promise.all([
        usdc.allowance(address, crowdfundAddress) as Promise<bigint>,
        usdc.balanceOf(address) as Promise<bigint>,
      ])
      setAllowance(allowanceResult)
      setBalance(balanceResult)
    } catch {
      // Non-fatal — will retry on next poll
    } finally {
      setLoading(false)
    }
  }, [address, usdcAddress, crowdfundAddress, provider])

  useEffect(() => {
    refresh()
  }, [refresh])

  const needsApproval = useCallback(
    (amount: bigint): boolean => {
      return allowance < amount
    },
    [allowance],
  )

  return { allowance, balance, loading, needsApproval, refresh }
}
