// ABOUTME: Unit tests for IndexedDB cache helpers.
// ABOUTME: Uses fake-indexeddb to test without a browser environment.

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCachedEvents,
  cacheEvents,
  getCachedENS,
  cacheENS,
  batchGetCachedENS,
  clearCache,
  _resetDB,
} from './cache.js'
import type { CrowdfundEvent } from './events.js'

const mkEvent = (type: CrowdfundEvent['type'], block: number): CrowdfundEvent => ({
  type,
  blockNumber: block,
  transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  logIndex: 0,
  args: {},
})

beforeEach(async () => {
  // Reset module state and clear cache contents
  _resetDB()
  await clearCache()
})

describe('event cache', () => {
  it('returns empty events and block 0 initially', async () => {
    const { events, lastBlock } = await getCachedEvents()
    expect(events).toEqual([])
    expect(lastBlock).toBe(0)
  })

  it('caches and retrieves events', async () => {
    const evts = [mkEvent('ArmLoaded', 1), mkEvent('SeedAdded', 2)]
    await cacheEvents(evts, 2)

    const { events, lastBlock } = await getCachedEvents()
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('ArmLoaded')
    expect(events[1].type).toBe('SeedAdded')
    expect(lastBlock).toBe(2)
  })

  it('appends events across multiple calls', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 1)
    await cacheEvents([mkEvent('SeedAdded', 2)], 2)

    const { events, lastBlock } = await getCachedEvents()
    expect(events).toHaveLength(2)
    expect(lastBlock).toBe(2)
  })
})

describe('ENS cache', () => {
  it('returns null for uncached address', async () => {
    const name = await getCachedENS('0x1234')
    expect(name).toBeNull()
  })

  it('caches and retrieves ENS name', async () => {
    await cacheENS('0xAbCd', 'alice.eth')
    const name = await getCachedENS('0xabcd')
    expect(name).toBe('alice.eth')
  })

  it('batch retrieves cached ENS names', async () => {
    await cacheENS('0xaaaa', 'alice.eth')
    await cacheENS('0xbbbb', 'bob.eth')

    const result = await batchGetCachedENS(['0xaaaa', '0xbbbb', '0xcccc'])
    expect(result.size).toBe(2)
    expect(result.get('0xaaaa')).toBe('alice.eth')
    expect(result.get('0xbbbb')).toBe('bob.eth')
  })
})

describe('clearCache', () => {
  it('clears all stores', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 1)
    await cacheENS('0xaaaa', 'alice.eth')

    await clearCache()

    const { events, lastBlock } = await getCachedEvents()
    expect(events).toEqual([])
    expect(lastBlock).toBe(0)

    const name = await getCachedENS('0xaaaa')
    expect(name).toBeNull()
  })
})
