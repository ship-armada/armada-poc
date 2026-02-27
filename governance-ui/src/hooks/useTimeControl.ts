// ABOUTME: Helper hook for fast-forwarding time on local Anvil chains.
// ABOUTME: Calls evm_increaseTime + evm_mine to advance blockchain time for testing.

import { useState, useCallback } from 'react'
import { JsonRpcProvider } from 'ethers'
import { getHubRpcUrl, isSepoliaMode } from '../config'

export interface TimeControl {
  fastForward: (seconds: number) => Promise<void>
  isAdvancing: boolean
  error: string | null
  isDisabled: boolean
}

export function useTimeControl(): TimeControl {
  const [isAdvancing, setIsAdvancing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isDisabled = isSepoliaMode()

  const fastForward = useCallback(async (seconds: number) => {
    if (isDisabled) {
      setError('Time control is only available on local Anvil chains')
      return
    }
    if (seconds <= 0) {
      setError('Seconds must be positive')
      return
    }

    setIsAdvancing(true)
    setError(null)

    try {
      const provider = new JsonRpcProvider(getHubRpcUrl())
      await provider.send('evm_increaseTime', [seconds])
      await provider.send('evm_mine', [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to advance time')
    } finally {
      setIsAdvancing(false)
    }
  }, [isDisabled])

  return { fastForward, isAdvancing, error, isDisabled }
}
