// ABOUTME: Resolves private USDC for UI — live shielded balance when synced, else net from completed tx history.

import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { computePrivateUsdcFromTxHistory } from '@/lib/balance/computePrivateUsdcFromTxHistory'
import { shieldedUsdcAtom, syncStateAtom } from '@/state/wallet'
import { activeTxListAtom } from '@/state/tx'

export interface PrivateUsdcDisplay {
  /** Live chain balance when the shielded sync has written the atom. */
  chainBalance: bigint | null
  /** Net balance implied by completed deposits/withdrawals on this device. */
  historyBalance: bigint
  /** Prefer chain; fall back to activity history so the UI matches Recent activity. */
  displayBalance: bigint
  /** True only when we have neither chain nor history and the first scan is still running. */
  isSyncing: boolean
}

export function usePrivateUsdcDisplay(): PrivateUsdcDisplay {
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const sync = useAtomValue(syncStateAtom)
  const txList = useAtomValue(activeTxListAtom)

  const historyBalance = useMemo(
    () => computePrivateUsdcFromTxHistory(txList),
    [txList],
  )

  const displayBalance = shieldedUsdc ?? historyBalance
  const isSyncing =
    sync.status === 'syncing' && shieldedUsdc === null && historyBalance === 0n

  return {
    chainBalance: shieldedUsdc,
    historyBalance,
    displayBalance,
    isSyncing,
  }
}
