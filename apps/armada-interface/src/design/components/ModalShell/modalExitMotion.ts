// ABOUTME: Shared exit-animation timing constants + CSS custom-property vars for the modal close choreography.
// ABOUTME: Ported from the armada-app design mockup.
import type { CSSProperties } from 'react'

/**
 * Modal motion
 *
 * Open / close (whole dialog):
 *   Enter — overlay, then header (500ms), then body after `--modal-step-enter-delay` (360ms).
 *   Close — content → header → backdrop (`MODAL_EXIT_TOTAL_MS`). Header stays until content
 *   has started leaving.
 *
 * Step change (same dialog):
 *   Wrap step bodies in `ModalStepSwitch`. Outgoing step plays `modalContentExit`
 *   (`MODAL_STEP_EXIT_MS`), then the incoming step mounts and uses the same enter
 *   animations with `--modal-step-enter-delay: 0ms`. Do not remount via `key` alone —
 *   that skips exit.
 */
export const MODAL_STEP_EXIT_MS = 220

/**
 * Close order: content → header → backdrop.
 * Timings mirror enter (header 500ms, body 360ms @ 360ms, overlay 240ms) at ~72% scale
 * so total exit (~700ms) matches perceived open speed (~720ms body reveal).
 */
export const MODAL_CONTENT_EXIT_MS = 260
export const MODAL_HEADER_EXIT_MS = 260
export const MODAL_HEADER_EXIT_DELAY_MS = 180
export const MODAL_OVERLAY_EXIT_MS = 180
export const MODAL_OVERLAY_EXIT_DELAY_MS = MODAL_HEADER_EXIT_DELAY_MS + MODAL_HEADER_EXIT_MS

export const MODAL_EXIT_TOTAL_MS = MODAL_OVERLAY_EXIT_DELAY_MS + MODAL_OVERLAY_EXIT_MS

export const MODAL_EXIT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

export const MODAL_EXIT_TIMING_VARS = {
  '--modal-content-exit-ms': `${MODAL_CONTENT_EXIT_MS}ms`,
  '--modal-header-exit-ms': `${MODAL_HEADER_EXIT_MS}ms`,
  '--modal-header-exit-delay': `${MODAL_HEADER_EXIT_DELAY_MS}ms`,
  '--modal-overlay-exit-ms': `${MODAL_OVERLAY_EXIT_MS}ms`,
  '--modal-overlay-exit-delay': `${MODAL_OVERLAY_EXIT_DELAY_MS}ms`,
  '--modal-exit-easing': MODAL_EXIT_EASING,
} as CSSProperties
