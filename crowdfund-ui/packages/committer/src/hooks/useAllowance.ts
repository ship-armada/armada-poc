// ABOUTME: USDC allowance checking for the commit flow.
// ABOUTME: Reads current allowance and balances; refresh() re-runs the read post-approval.

import { useCallback, useMemo } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { useQuery } from '@tanstack/react-query'
import { ERC20_ABI_FRAGMENTS, aggregate3, type AggregateCall } from '@armada/crowdfund-shared'

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
  /** Poll cadence for balance + allowance reads. Required to keep the navbar
   *  USDC badge and the Participate modal's "Available" line responsive to
   *  on-chain activity that happens outside this tab (faucets, manual
   *  transfers, other dapps). Omit (or pass `false`) to disable polling. */
  pollIntervalMs?: number | false,
): UseAllowanceResult {
  const enabled = !!address && !!usdcAddress && !!crowdfundAddress && !!provider

  const query = useQuery({
    queryKey: ['usdcAllowance', address, usdcAddress, crowdfundAddress, armTokenAddress],
    queryFn: async (): Promise<AllowanceSnapshot> => {
      // Batch the USDC allowance + balance (+ optional ARM balance) into one
      // Multicall3 eth_call instead of 2–3 separate reads per tick.
      const usdc = new Contract(usdcAddress!, ERC20_ABI_FRAGMENTS, provider!)
      const calls: AggregateCall[] = [
        { contract: usdc, functionName: 'allowance', args: [address, crowdfundAddress] },
        { contract: usdc, functionName: 'balanceOf', args: [address] },
      ]
      const arm = armTokenAddress ? new Contract(armTokenAddress, ERC20_ABI_FRAGMENTS, provider!) : null
      if (arm) calls.push({ contract: arm, functionName: 'balanceOf', args: [address] })

      const results = await aggregate3(provider!, calls)
      // The allowance + balance are load-bearing (they gate approval/limits) — a
      // failed read must error the tick rather than silently read as zero. The
      // ARM balance is display-only, so a failure there carries to zero.
      if (!results[0].success || !results[1].success) {
        throw new Error('Allowance/balance read failed')
      }
      return {
        allowance: results[0].result![0] as bigint,
        balance: results[1].result![0] as bigint,
        armBalance: arm && results[2]?.success ? (results[2].result![0] as bigint) : 0n,
      }
    },
    enabled,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchInterval: pollIntervalMs ?? false,
    refetchIntervalInBackground: false,
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
