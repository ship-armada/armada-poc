// ABOUTME: Reads settled tx history from txListAtom and derives the Send flow's recent-recipients list.
// ABOUTME: Thin wrapper so components stay dumb — the dedupe/sort/cap logic lives in lib/tx/recentRecipients.

import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { txListAtom } from '@/state/tx'
import { getNetworkConfig } from '@/config/network'
import { deriveRecentRecipients, type RecentRecipient } from '@/lib/tx/recentRecipients'

/** The user's `limit` most recently used distinct recipients, newest-first. Empty when no history. */
export function useRecentRecipients(limit = 5): RecentRecipient[] {
  const records = useAtomValue(txListAtom)
  const hubChainId = getNetworkConfig().hub.chainId
  return useMemo(
    () => deriveRecentRecipients(records, { hubChainId, limit }),
    [records, hubChainId, limit],
  )
}
