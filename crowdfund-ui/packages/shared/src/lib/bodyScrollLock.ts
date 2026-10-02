// ABOUTME: Counted page scroll lock shared by every modal and bottom sheet.
// ABOUTME: The first lock saves the page's styles and pins it; only the last release restores them.

/** Saved page styles + scroll position from before the first active lock. */
interface SavedPage {
  htmlOverflow: string
  htmlOverscroll: string
  bodyOverflow: string
  bodyOverscroll: string
  bodyPosition: string
  bodyTop: string
  bodyLeft: string
  bodyRight: string
  bodyWidth: string
  scrollY: number
}

let activeLocks = 0
let saved: SavedPage | null = null

/**
 * Lock page scroll; returns a release function (safe to call more than once).
 * `overflow: hidden` alone is not enough on iOS / when the hero page scrolls the
 * document, so the body is pinned with `position: fixed` at the current offset.
 * Overlays can stack (a sheet over a modal) and close in any order: each holds
 * one lock, and the page is restored only when none remain.
 */
export function lockBodyScroll(): () => void {
  const html = document.documentElement
  const body = document.body
  if (activeLocks === 0) {
    const scrollY = window.scrollY
    saved = {
      htmlOverflow: html.style.overflow,
      htmlOverscroll: html.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      scrollY,
    }
    html.style.overflow = 'hidden'
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    body.style.overscrollBehavior = 'none'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
  }
  activeLocks += 1

  let released = false
  return () => {
    if (released) return
    released = true
    activeLocks -= 1
    if (activeLocks > 0 || !saved) return
    const prev = saved
    saved = null
    html.style.overflow = prev.htmlOverflow
    html.style.overscrollBehavior = prev.htmlOverscroll
    body.style.overflow = prev.bodyOverflow
    body.style.overscrollBehavior = prev.bodyOverscroll
    body.style.position = prev.bodyPosition
    body.style.top = prev.bodyTop
    body.style.left = prev.bodyLeft
    body.style.right = prev.bodyRight
    body.style.width = prev.bodyWidth
    window.scrollTo(0, prev.scrollY)
  }
}
