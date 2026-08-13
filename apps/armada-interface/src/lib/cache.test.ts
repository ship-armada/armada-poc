// ABOUTME: Tests for cache.ts::cacheReadModifyWrite — atomic get→decide→put in one IDB transaction, so
// ABOUTME: two concurrent same-key compare-and-sets can't both read a stale value and both write.

import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { cacheReadModifyWrite, cacheGet, cachePut } from './cache'

describe('cacheReadModifyWrite', () => {
  it('writes on { put } (returns true); skips on { skip } (returns false)', async () => {
    const wrote = await cacheReadModifyWrite<number, number>('meta', 'k1', () => ({ put: 7 }))
    expect(wrote).toBe(true)
    expect(await cacheGet<number>('meta', 'k1')).toBe(7)

    const skipped = await cacheReadModifyWrite<number, number>('meta', 'k1', () => ({ skip: true }))
    expect(skipped).toBe(false)
    expect(await cacheGet<number>('meta', 'k1')).toBe(7) // unchanged
  })

  it('decide sees the current stored value', async () => {
    await cachePut('meta', 'k3', 41)
    await cacheReadModifyWrite<number, number>('meta', 'k3', (v) => ({ put: (v ?? 0) + 1 }))
    expect(await cacheGet<number>('meta', 'k3')).toBe(42)
  })

  it('is ATOMIC under concurrency — two same-key read-increments both apply (no lost update)', async () => {
    await cachePut('meta', 'ctr', 0)
    // Fire two RMWs concurrently; each reads the current value and writes value+1. With the old
    // cacheGet-then-cachePut split (two transactions) both would read 0 and the store would end at 1.
    // One transaction per call → IndexedDB serializes them, so the second reads the first's write → 2.
    await Promise.all([
      cacheReadModifyWrite<number, number>('meta', 'ctr', (v) => ({ put: (v ?? 0) + 1 })),
      cacheReadModifyWrite<number, number>('meta', 'ctr', (v) => ({ put: (v ?? 0) + 1 })),
    ])
    expect(await cacheGet<number>('meta', 'ctr')).toBe(2)
  })

  it('aborts the transaction (no write) when decide throws', async () => {
    await cachePut('meta', 'k2', 'orig')
    await expect(
      cacheReadModifyWrite<string, string>('meta', 'k2', () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await cacheGet<string>('meta', 'k2')).toBe('orig') // unchanged
  })
})
