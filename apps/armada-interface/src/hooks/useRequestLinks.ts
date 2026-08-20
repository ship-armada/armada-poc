// ABOUTME: Hydrates requestLinksAtom from the encrypted per-wallet store on unlock, and exposes an append callback.
// ABOUTME: Mirrors useTxHistory's scoping — reset the atom on wallet change, hydrate only when unlocked.

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import { requestLinksAtom } from '@/state/requestLinks'
import { loadRequestLinks, saveRequestLink, type RequestLinkRecord } from '@/lib/shielded/requestLinks'
import { trackError } from '@/lib/telemetry'

/** App-root hydrator: loads the active wallet's created links into `requestLinksAtom` on unlock. */
export function useRequestLinks(): void {
  const setLinks = useSetAtom(requestLinksAtom)
  const active = useAtomValue(activeShieldedWalletAtom)
  const activeWalletId = active?.id ?? null
  const activeStatus = active?.status ?? null

  useEffect(() => {
    let cancelled = false
    setLinks([])
    if (!activeWalletId || activeStatus !== 'unlocked') {
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        const links = await loadRequestLinks(activeWalletId)
        if (cancelled) return
        links.sort((a, b) => b.createdAt - a.createdAt)
        setLinks(links)
      } catch (err) {
        trackError('useRequestLinks.hydrate', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeWalletId, activeStatus, setLinks])
}

/** Persist a newly created link + prepend it to the in-memory list (newest first). */
export function useAddRequestLink(): (record: RequestLinkRecord) => Promise<void> {
  const setLinks = useSetAtom(requestLinksAtom)
  return useCallback(
    async (record: RequestLinkRecord) => {
      await saveRequestLink(record)
      setLinks((prev) => [record, ...prev.filter((l) => l.requestId !== record.requestId)])
    },
    [setLinks],
  )
}
