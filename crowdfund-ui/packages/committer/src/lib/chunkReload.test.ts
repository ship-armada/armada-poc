// ABOUTME: Tests for the reload-once recovery when a lazy route chunk fails to download.
// ABOUTME: A dropped connection should reload the page once, never loop, and otherwise let the error surface.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CHUNK_RELOAD_RETRY_WINDOW_MS, CHUNK_RELOAD_PENDING_MS } from './chunkReload'

// The pending-reload flag is module state; re-import per test so it starts clear.
type ChunkReloadModule = typeof import('./chunkReload')
let chunkReload: ChunkReloadModule

function firePreloadError(): Event {
  const event = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('installChunkReloadHandler', () => {
  let reload: ReturnType<typeof vi.fn<() => void>>
  let uninstall: () => void

  beforeEach(async () => {
    vi.resetModules()
    chunkReload = await import('./chunkReload')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    window.sessionStorage.clear()
    reload = vi.fn<() => void>()
    uninstall = chunkReload.installChunkReloadHandler(reload)
  })

  afterEach(() => {
    uninstall()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reloads the page and suppresses the error on the first failure', () => {
    const event = firePreloadError()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(chunkReload.isChunkReloadPending()).toBe(true)
  })

  it('clears the pending flag if the page survives the reload (e.g. "Leave site?" cancelled)', () => {
    firePreloadError()
    vi.advanceTimersByTime(CHUNK_RELOAD_PENDING_MS)

    expect(chunkReload.isChunkReloadPending()).toBe(false)
  })

  it('reports no pending reload before any failure', () => {
    expect(chunkReload.isChunkReloadPending()).toBe(false)
  })

  it('lets the error surface instead of looping when the reload just happened', () => {
    firePreloadError()
    // The reloaded page fails to fetch the chunk again (still offline).
    vi.advanceTimersByTime(2_000)
    const event = firePreloadError()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('reloads again for a later, unrelated failure in the same tab', () => {
    firePreloadError()
    vi.advanceTimersByTime(CHUNK_RELOAD_RETRY_WINDOW_MS + 1)
    const event = firePreloadError()

    expect(reload).toHaveBeenCalledTimes(2)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not reload when sessionStorage is unavailable (no loop guard)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const event = firePreloadError()

    expect(reload).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(chunkReload.isChunkReloadPending()).toBe(false)
  })
})
