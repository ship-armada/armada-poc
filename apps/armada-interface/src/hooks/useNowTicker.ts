// ABOUTME: Writes Date.now() into nowAtom on a 60s cadence so relative-time labels refresh without navigation.
// ABOUTME: Mount once at App root. Pauses while the tab is hidden; re-stamps immediately on visibility return.

import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { nowAtom } from '@/state/time'
import { tabVisibleAtom } from '@/state/visibility'

const TICK_MS = 60_000

export function useNowTicker(): void {
  const setNow = useSetAtom(nowAtom)
  const tabVisible = useAtomValue(tabVisibleAtom)
  useEffect(() => {
    if (!tabVisible) return
    // Immediate refresh on mount + on visibility return — the user expects "now" to be current
    // the moment they look at the screen, not up to a minute stale.
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [tabVisible, setNow])
}
