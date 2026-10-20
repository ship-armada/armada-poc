// ABOUTME: Browser polyfills installed once at committer startup, each guarded by feature detection.
// ABOUTME: Best-effort support for browsers below the Safari 16 build target (e.g. iOS 15); a no-op elsewhere.

/**
 * Install polyfills for APIs the app uses that older browsers lack. Each one is
 * feature-detected, so on browsers that ship the API natively nothing changes.
 *
 * - `AbortSignal.timeout` (Safari 16+): used for the deployment-manifest and
 *   indexer fetch timeouts. Without it iOS 15 throws before the manifest loads
 *   and the app never starts.
 */
export function installPolyfills(): void {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = (milliseconds: number): AbortSignal => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), milliseconds)
      return controller.signal
    }
  }
}
