// ABOUTME: React hook that traps keyboard Tab focus within a container element while active.
// ABOUTME: Ported from the armada-app design mockup.
import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled') && element.tabIndex !== -1,
  )
}

/** Keep keyboard focus inside `containerRef` while `active`. */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return

    const container = containerRef.current
    if (!container) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !containerRef.current) return

      const focusable = getFocusableElements(containerRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement

      if (event.shiftKey) {
        if (activeElement === first || !containerRef.current.contains(activeElement)) {
          event.preventDefault()
          last?.focus()
        }
        return
      }

      if (activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [active, containerRef])
}
