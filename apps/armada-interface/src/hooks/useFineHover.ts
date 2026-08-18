// ABOUTME: React hook reporting whether the device supports fine hover (mouse / trackpad) vs coarse touch.
// ABOUTME: Ported from the armada-app design mockup; drives hover-vs-tap tooltip behaviour.
import { useSyncExternalStore } from 'react'

const FINE_HOVER_QUERY = '(hover: hover) and (pointer: fine)'

function subscribe(onStoreChange: () => void) {
  const mediaQuery = window.matchMedia(FINE_HOVER_QUERY)
  mediaQuery.addEventListener('change', onStoreChange)
  return () => mediaQuery.removeEventListener('change', onStoreChange)
}

function getFineHoverSnapshot() {
  return window.matchMedia(FINE_HOVER_QUERY).matches
}

function getFineHoverServerSnapshot() {
  return true
}

/** True when the device can hover without a sticky tap (mouse / trackpad). */
export function useFineHover() {
  return useSyncExternalStore(subscribe, getFineHoverSnapshot, getFineHoverServerSnapshot)
}
