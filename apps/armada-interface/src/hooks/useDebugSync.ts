// ABOUTME: Syncs the `?debug` URL param into the persisted debugModeAtom on mount. Mount once at App root.
// ABOUTME: `?debug` / `?debug=1`/`true` enable; `?debug=0`/`false` disable; absent leaves the stored value alone.

import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { debugModeAtom } from '@/state/debug'

/** Parse a `?debug` value into on/off/unset. Exported for unit testing. */
export function parseDebugParam(search: string): boolean | null {
  const params = new URLSearchParams(search)
  if (!params.has('debug')) return null
  const raw = (params.get('debug') ?? '').toLowerCase()
  // Bare `?debug` (empty value) counts as on.
  if (raw === '' || raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  return true
}

export function useDebugSync(): void {
  const setDebug = useSetAtom(debugModeAtom)
  useEffect(() => {
    const next = parseDebugParam(window.location.search)
    if (next !== null) setDebug(next)
  }, [setDebug])
}
