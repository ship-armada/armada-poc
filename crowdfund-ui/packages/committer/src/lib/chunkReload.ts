// ABOUTME: Recovers from a lazy route chunk that failed to download (Vite's `vite:preloadError`).
// ABOUTME: Reloads the page once so a dropped connection doesn't strand the user on the crash fallback.

/**
 * If a chunk fails again within this window of an automatic reload, the
 * failure is persistent (offline, or the asset is really gone): stop reloading
 * and let the error reach the error boundary and Sentry.
 */
export const CHUNK_RELOAD_RETRY_WINDOW_MS = 10_000

/**
 * How long errors are treated as reload fallout. The fallout fires within
 * milliseconds of the failure; the bound matters when the reload doesn't
 * happen (the user cancels the "Leave site?" prompt shown while a transaction
 * is in flight), so Sentry doesn't stay muted for the rest of the session.
 */
export const CHUNK_RELOAD_PENDING_MS = 5_000

const LAST_RELOAD_KEY = 'armada:chunk-reload-at'

let reloadPending = false

/**
 * True once a chunk failure has triggered a reload. Cancelling the error makes
 * Vite hand its caller `undefined` instead of the module, so the caller then
 * throws (e.g. reading `.default` of undefined) before the page unloads; Sentry
 * uses this to drop that fallout.
 */
export function isChunkReloadPending(): boolean {
  return reloadPending
}

/**
 * Listen for Vite's `vite:preloadError` (fired when a lazily imported route
 * chunk or its CSS fails to load, typically a mobile connection dropping
 * mid-fetch) and reload the page instead of throwing. The sessionStorage
 * timestamp is the loop guard; without storage there's no guard, so the error
 * is left to surface. Returns an uninstall function.
 */
export function installChunkReloadHandler(reload: () => void = () => window.location.reload()): () => void {
  const onPreloadError = (event: Event) => {
    try {
      const lastReloadAt = Number(window.sessionStorage.getItem(LAST_RELOAD_KEY) ?? 0)
      if (Date.now() - lastReloadAt < CHUNK_RELOAD_RETRY_WINDOW_MS) return
      window.sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()))
    } catch {
      return
    }
    reloadPending = true
    window.setTimeout(() => {
      reloadPending = false
    }, CHUNK_RELOAD_PENDING_MS)
    event.preventDefault()
    reload()
  }
  window.addEventListener('vite:preloadError', onPreloadError)
  return () => window.removeEventListener('vite:preloadError', onPreloadError)
}
