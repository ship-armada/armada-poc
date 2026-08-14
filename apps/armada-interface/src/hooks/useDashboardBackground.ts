// ABOUTME: Dashboard background preference hook — minimal stub returning the default gradient background.
// ABOUTME: The mockup's solid/gradient toggle UI is not ported yet; always resolves to 'gradient'.
import { useCallback } from 'react'

export type DashboardBackground = 'gradient' | 'solid'

export function useDashboardBackground() {
  const applyBackground = useCallback((_next: DashboardBackground) => {}, [])
  return ['gradient' as DashboardBackground, applyBackground] as const
}
