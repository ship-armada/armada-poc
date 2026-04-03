// ABOUTME: Local-only time manipulation via Anvil RPC methods.
// ABOUTME: Provides time warp functions for testing crowdfund lifecycle phases.

import { useCallback } from 'react'
import type { JsonRpcProvider } from 'ethers'

export interface UseTimeControlsResult {
  advanceTime: (seconds: number) => Promise<void>
  skipToWeek1End: (launchTeamInviteEnd: number, blockTimestamp: number) => Promise<void>
  skipToWindowEnd: (windowEnd: number, blockTimestamp: number) => Promise<void>
  skipToClaimDeadline: (claimDeadline: number, blockTimestamp: number) => Promise<void>
  setBalance: (address: string, ethAmount: string) => Promise<void>
}

export function useTimeControls(provider: JsonRpcProvider | null): UseTimeControlsResult {
  const advanceTime = useCallback(async (seconds: number) => {
    if (!provider || seconds <= 0) return
    await provider.send('evm_increaseTime', [seconds])
    await provider.send('evm_mine', [])
  }, [provider])

  const skipToWeek1End = useCallback(async (launchTeamInviteEnd: number, blockTimestamp: number) => {
    if (!provider || launchTeamInviteEnd <= blockTimestamp) return
    const delta = launchTeamInviteEnd - blockTimestamp + 1
    await advanceTime(delta)
  }, [provider, advanceTime])

  const skipToWindowEnd = useCallback(async (windowEnd: number, blockTimestamp: number) => {
    if (!provider || windowEnd <= blockTimestamp) return
    const delta = windowEnd - blockTimestamp + 1
    await advanceTime(delta)
  }, [provider, advanceTime])

  const skipToClaimDeadline = useCallback(async (claimDeadline: number, blockTimestamp: number) => {
    if (!provider || claimDeadline <= blockTimestamp) return
    const delta = claimDeadline - blockTimestamp + 1
    await advanceTime(delta)
  }, [provider, advanceTime])

  const setBalance = useCallback(async (address: string, ethAmount: string) => {
    if (!provider) return
    const wei = BigInt(Math.floor(parseFloat(ethAmount) * 1e18))
    await provider.send('anvil_setBalance', [address, '0x' + wei.toString(16)])
  }, [provider])

  return { advanceTime, skipToWeek1End, skipToWindowEnd, skipToClaimDeadline, setBalance }
}
