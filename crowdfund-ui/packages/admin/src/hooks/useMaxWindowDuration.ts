// ABOUTME: Reads the crowdfund's MAX_WINDOW_DURATION once, tolerating contracts that predate it.
// ABOUTME: Returns undefined while loading, null when the contract has no window extension, else seconds.

import { useEffect, useState } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

/**
 * Kept out of useAdminState's batched reads on purpose: those reads fail together, and a crowdfund
 * deployed before extendWindow existed (e.g. the canceled Launch 1 sale, which still serves
 * refunds) reverts on MAX_WINDOW_DURATION(). Here that just means "no extension available".
 */
export function useMaxWindowDuration(
  provider: JsonRpcProvider | null,
  crowdfundAddress: string | null,
): number | null | undefined {
  const [value, setValue] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    setValue(undefined)
    if (!provider || !crowdfundAddress) return
    let cancelled = false
    const contract = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)
    ;(contract.MAX_WINDOW_DURATION() as Promise<bigint>)
      .then((seconds) => { if (!cancelled) setValue(Number(seconds)) })
      .catch(() => { if (!cancelled) setValue(null) })
    return () => { cancelled = true }
  }, [provider, crowdfundAddress])

  return value
}
