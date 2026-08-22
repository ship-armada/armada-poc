// ABOUTME: Hook reporting whether the viewport is in the phone layout (≤479px: bottom sheets, keypad).
// ABOUTME: Ported from the armada-app design mockup.
import { useSyncExternalStore } from 'react'
import { MOBILE_LAYOUT_MAX_WIDTH_PX } from '@/constants/viewportBreakpoints'

const MOBILE_LAYOUT_QUERY = `(max-width: ${MOBILE_LAYOUT_MAX_WIDTH_PX}px)`

function subscribe(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(MOBILE_LAYOUT_QUERY)
  mediaQuery.addEventListener('change', onStoreChange)
  return () => mediaQuery.removeEventListener('change', onStoreChange)
}

function getMobileLayoutSnapshot() {
  return window.matchMedia(MOBILE_LAYOUT_QUERY).matches
}

function getMobileLayoutServerSnapshot() {
  return false
}

/** True when viewport width is ≤479px (touch-first mobile layout). */
export function useMobileLayout() {
  return useSyncExternalStore(subscribe, getMobileLayoutSnapshot, getMobileLayoutServerSnapshot)
}

export { MOBILE_LAYOUT_MAX_WIDTH_PX, MOBILE_LAYOUT_QUERY }
