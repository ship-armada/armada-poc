// ABOUTME: Registers a native beforeunload leave-confirmation while a tx pipeline is in flight.
// ABOUTME: Warns the user before they refresh or close the tab mid-transaction; removed when idle.

import { useEffect } from 'react'

/**
 * While `active` is true, register a `beforeunload` handler that triggers the
 * browser's leave-confirmation prompt. Removed as soon as `active` goes false
 * or the component unmounts. The transaction is not cancellable from here — the
 * prompt only gives the user a chance not to navigate away mid-submission.
 */
export function useBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}
