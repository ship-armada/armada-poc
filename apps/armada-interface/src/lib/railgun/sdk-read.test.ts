// ABOUTME: Unit test for sdk-read's syncTracked — asserts each wallet.sync() emits an sdk.sync
// ABOUTME: telemetry line carrying the exact resume window, so resume-vs-rescan stays observable.

import { describe, it, expect, vi } from 'vitest'

// Stub the heavy @armada/sdk value imports so importing sdk-read doesn't pull the SDK/wasm into the
// test — syncTracked only needs the wallet's `sync()` return, not any real SDK runtime.
vi.mock('@armada/sdk', () => ({
  createArmadaSdk: vi.fn(),
  IndexedDBStorageAdapter: class {},
  getTokenDataERC20: vi.fn(),
  getTokenDataHash: vi.fn(),
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

import { syncTracked } from './sdk-read'
import { track } from '@/lib/telemetry'

describe('syncTracked', () => {
  it('emits sdk.sync with the exact { fromBlock, syncedThrough, scanned } sync returned', async () => {
    // WHY: fromBlock and syncedThrough are both numbers, so a field swap wouldn't be caught by
    // types — but it would make the resume-vs-rescan signal lie. Pin the mapping.
    const wallet = { sync: vi.fn(async () => ({ fromBlock: 501, syncedThrough: 520, scanned: true })) }
    await syncTracked(wallet)
    expect(track).toHaveBeenCalledWith('sdk.sync', {
      fromBlock: 501,
      syncedThrough: 520,
      scanned: true,
    })
  })

  it('reports scanned:false for a no-op sync (head not advanced past the checkpoint)', async () => {
    // WHY: the cheap-path signal — a warm reload with no new blocks. fromBlock stays checkpoint+1.
    const wallet = { sync: vi.fn(async () => ({ fromBlock: 521, syncedThrough: 520, scanned: false })) }
    await syncTracked(wallet)
    expect(track).toHaveBeenCalledWith('sdk.sync', {
      fromBlock: 521,
      syncedThrough: 520,
      scanned: false,
    })
  })

  it('serializes concurrent syncs — wallet.sync() never overlaps', async () => {
    // WHY: the SDK's sync() has no in-flight guard; two concurrent scans would double-apply the same
    // events and corrupt the scan state. syncTracked chains them so at most one runs at a time.
    let active = 0
    let maxConcurrent = 0
    const wallet = {
      sync: vi.fn(async () => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return { fromBlock: 1, syncedThrough: 2, scanned: true }
      }),
    }
    await Promise.all([syncTracked(wallet), syncTracked(wallet), syncTracked(wallet)])
    expect(maxConcurrent).toBe(1)
    expect(wallet.sync).toHaveBeenCalledTimes(3)
  })

  it('a failing sync does not wedge the chain for later callers', async () => {
    const wallet = {
      sync: vi
        .fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce({ fromBlock: 1, syncedThrough: 2, scanned: true }),
    }
    await expect(syncTracked(wallet)).rejects.toThrow('rpc down')
    // The next caller still runs (the chain caught the rejection).
    await expect(syncTracked(wallet)).resolves.toBeUndefined()
    expect(wallet.sync).toHaveBeenCalledTimes(2)
  })
})
