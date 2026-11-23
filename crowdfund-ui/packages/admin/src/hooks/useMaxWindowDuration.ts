// ABOUTME: Reads the crowdfund's MAX_WINDOW_DURATION once, tolerating contracts that predate it.
// ABOUTME: Returns undefined while loading, null when the contract has no window extension, else seconds.

import { useEffect, useState } from 'react'
import { Contract, isError } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

/** Delay before re-reading after an RPC error (timeout, dropped connection). */
const RETRY_MS = 15_000

/**
 * Kept out of useAdminState's batched reads on purpose: those reads fail together, and a crowdfund
 * deployed before extendWindow existed (e.g. the canceled Launch 1 sale, which still serves
 * refunds) reverts on MAX_WINDOW_DURATION(). Only a revert means "no extension available"; any
 * other error is an RPC problem, so the read is retried and the result stays undefined meanwhile.
 */
export function useMaxWindowDuration(
  provider: JsonRpcProvider | null,
  crowdfundAddress: string | null,
  retryMs: number = RETRY_MS,
): number | null | undefined {
  const [value, setValue] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    setValue(undefined)
    if (!provider || !crowdfundAddress) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const contract = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)
    const read = () => {
      ;(contract.MAX_WINDOW_DURATION() as Promise<bigint>)
        .then((seconds) => { if (!cancelled) setValue(Number(seconds)) })
        .catch((err: unknown) => {
          if (cancelled) return
          if (isError(err, 'CALL_EXCEPTION')) setValue(null)
          else retryTimer = setTimeout(read, retryMs)
        })
    }
    read()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [provider, crowdfundAddress, retryMs])

  return value
}
