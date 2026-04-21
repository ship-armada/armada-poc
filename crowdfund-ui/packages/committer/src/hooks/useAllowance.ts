// ABOUTME: USDC allowance checking for the commit flow.
// ABOUTME: Reads current allowance and balances; refresh() re-runs the read post-approval.

import { useCallback, useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { useQuery } from '@tanstack/react-query'
import { ERC20_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

export interface UseAllowanceResult {
  allowance: bigint
  balance: bigint
  armBalance: bigint
  loading: boolean
  needsApproval: (amount: bigint) => boolean
  refresh: () => Promise<void>
}

interface AllowanceSnapshot {
  allowance: bigint
  balance: bigint
  armBalance: bigint
}

const ZERO_SNAPSHOT: AllowanceSnapshot = {
  allowance: 0n,
  balance: 0n,
  armBalance: 0n,
}

export function useAllowance(
  address: string | null,
  usdcAddress: string | null,
  crowdfundAddress: string | null,
  armTokenAddress: string | null,
  provider: JsonRpcProvider | null,
): UseAllowanceResult {
  const enabled = !!address && !!usdcAddress && !!crowdfundAddress && !!provider

  const query = useQuery({
    queryKey: ['usdcAllowance', address, usdcAddress, crowdfundAddress, armTokenAddress],
    queryFn: async (): Promise<AllowanceSnapshot> => {
      const usdc = new Contract(usdcAddress!, ERC20_ABI_FRAGMENTS, provider!)
      const readAllowance = usdc.allowance(address, crowdfundAddress) as Promise<bigint>
      const readBalance = usdc.balanceOf(address) as Promise<bigint>
      const readArm = armTokenAddress
        ? (new Contract(armTokenAddress, ERC20_ABI_FRAGMENTS, provider!).balanceOf(address) as Promise<bigint>)
        : Promise.resolve(0n)

      const [allowance, balance, armBalance] = await Promise.all([
        readAllowance,
        readBalance,
        readArm,
      ])
      return { allowance, balance, armBalance }
    },
    enabled,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    retry: false,
  })

  const snapshot = query.data ?? ZERO_SNAPSHOT

  const refresh = useCallback(async () => {
    await query.refetch()
  }, [query])

  const needsApproval = useCallback(
    (amount: bigint): boolean => snapshot.allowance < amount,
    [snapshot.allowance],
  )

  // Preserve prior semantic: loading is `false` when the hook is inactive
  // (no wallet / no addresses), `true` only while an enabled fetch is in-flight.
  const loading = enabled && query.isPending

  return useMemo(
    () => ({
      allowance: snapshot.allowance,
      balance: snapshot.balance,
      armBalance: snapshot.armBalance,
      loading,
      needsApproval,
      refresh,
    }),
    [snapshot, loading, needsApproval, refresh],
  )
}
