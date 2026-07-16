// ABOUTME: Single visibilitychange listener that publishes to tabVisibleAtom. Mount once at app root.
// ABOUTME: Pollers read tabVisibleAtom; this hook is the only place document.visibilityState is touched.

import { useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { tabVisibleAtom } from '@/state/visibility'
import { markHidden, markVisible } from '@/lib/tx/hiddenClock'

export function useTabVisible(): void {
  const setVisible = useSetAtom(tabVisibleAtom)
  useEffect(() => {
    const sync = () => {
      const visible = document.visibilityState === 'visible'
      setVisible(visible)
      // Feed the hidden-clock from the same signal the executor's visibility gate reads, so a tx's
      // wall-clock budget is credited for time the tab spent hidden (T-M5 / S-M6).
      if (visible) markVisible(Date.now())
      else markHidden(Date.now())
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [setVisible])
}
