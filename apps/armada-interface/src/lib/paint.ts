// ABOUTME: yieldToPaint — resolves after one paint frame so a just-set "Generating proof…" UI
// ABOUTME: actually renders before a long thread-blocking synchronous task (WASM ZK proof gen) starts.

/**
 * Resolve after the browser has had a chance to paint one frame. Call this immediately before a
 * long, thread-blocking synchronous operation (ZK proof generation) so the UI state the caller
 * just set ("Generating proof…") paints first instead of being starved until the work finishes.
 *
 * Uses `requestAnimationFrame` when available; falls back to `setTimeout(0)` in non-DOM contexts
 * (tests, workers) so callers can `await` it unconditionally.
 */
export function yieldToPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}
