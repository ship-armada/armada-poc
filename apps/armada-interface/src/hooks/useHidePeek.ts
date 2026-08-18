// ABOUTME: Builds pointer/hover event handlers that momentarily reveal a hidden balance while pressed or hovered.
// ABOUTME: Ported from the armada-app design mockup; shared by BalanceCard, VaultPositionBar, and RecentActivityList.
import type { HTMLAttributes } from 'react'

export function hidePeekEventHandlers(
  enabled: boolean,
  reveal: () => void,
  hide: () => void,
  isMobile: boolean,
): HTMLAttributes<HTMLElement> {
  if (!enabled) return {}

  if (isMobile) {
    return {
      onPointerDown: reveal,
      onPointerUp: hide,
      onPointerCancel: hide,
    }
  }

  return {
    onMouseEnter: reveal,
    onMouseLeave: hide,
    onFocus: reveal,
    onBlur: hide,
  }
}
