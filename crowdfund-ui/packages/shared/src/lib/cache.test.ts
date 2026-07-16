// ABOUTME: Unit tests for IndexedDB cache helpers.
// ABOUTME: Uses fake-indexeddb to test without a browser environment.

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCachedEvents,
  cacheEvents,
  getCachedENS,
  getCachedENSEntry,
  cacheENS,
  batchGetCachedENS,
  clearCache,
  _resetDB,
} from './cache.js'
import type { CrowdfundEvent } from './events.js'

const mkEvent = (
  type: CrowdfundEvent['type'],
  block: number,
  logIndex = 0,
): CrowdfundEvent => ({
  type,
  blockNumber: block,
  transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  logIndex,
  args: {},
})

const DEPLOYMENT_A = { chainId: 11155111, contractAddress: '0xAAaA000000000000000000000000000000000001' }
const DEPLOYMENT_B = { chainId: 11155111, contractAddress: '0xBBbB000000000000000000000000000000000002' }

beforeEach(async () => {
  // Reset module state and clear cache contents
  _resetDB()
  await clearCache()
})

describe('event cache', () => {
  it('returns empty events and block 0 initially', async () => {
    const { events, lastBlock } = await getCachedEvents(DEPLOYMENT_A)
    expect(events).toEqual([])
    expect(lastBlock).toBe(0)
  })

  it('caches and retrieves events', async () => {
    const evts = [mkEvent('ArmLoaded', 1), mkEvent('SeedAdded', 2)]
    await cacheEvents(evts, 2, DEPLOYMENT_A)

    const { events, lastBlock } = await getCachedEvents(DEPLOYMENT_A)
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('ArmLoaded')
    expect(events[1].type).toBe('SeedAdded')
    expect(lastBlock).toBe(2)
  })

  it('appends events across multiple calls', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 1, DEPLOYMENT_A)
    await cacheEvents([mkEvent('SeedAdded', 2)], 2, DEPLOYMENT_A)

    const { events, lastBlock } = await getCachedEvents(DEPLOYMENT_A)
    expect(events).toHaveLength(2)
    expect(lastBlock).toBe(2)
  })

  it('does not grow the store when the same events are cached twice (dedup)', async () => {
    const evts = [mkEvent('ArmLoaded', 1, 0), mkEvent('SeedAdded', 1, 1)]
    await cacheEvents(evts, 1, DEPLOYMENT_A)
    await cacheEvents(evts, 1, DEPLOYMENT_A)

    const { events } = await getCachedEvents(DEPLOYMENT_A)
    expect(events).toHaveLength(2)
  })

  it('clears the event store when the deployment changes', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 5, DEPLOYMENT_A)
    expect((await getCachedEvents(DEPLOYMENT_A)).events).toHaveLength(1)

    // Switching deployments clears the foreign history.
    const switched = await getCachedEvents(DEPLOYMENT_B)
    expect(switched.events).toEqual([])
    expect(switched.lastBlock).toBe(0)
  })

  it('resets the cursor on a return visit after a switch (A → B → A)', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 5, DEPLOYMENT_A)
    await getCachedEvents(DEPLOYMENT_B) // switch away clears A's events
    const back = await getCachedEvents(DEPLOYMENT_A)
    expect(back.events).toEqual([])
    expect(back.lastBlock).toBe(0)
  })

  it('namespaces the cursor per deployment', async () => {
    await cacheEvents([mkEvent('ArmLoaded', 1)], 7, DEPLOYMENT_A)
    // Reading the same deployment sees its cursor.
    expect((await getCachedEvents(DEPLOYMENT_A)).lastBlock).toBe(7)
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

  it('caches a negative (no ENS) distinctly from a cache miss', async () => {
    await cacheENS('0xno0000000000000000000000000000000000ens0', null)
    // getCachedENS returns null for both, but the entry getter distinguishes them.
    const cachedNegative = await getCachedENSEntry('0xno0000000000000000000000000000000000ens0')
    expect(cachedNegative).toEqual({ name: null })
    const miss = await getCachedENSEntry('0xnevercached00000000000000000000000000000')
    expect(miss).toBeNull()
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
    await cacheEvents([mkEvent('ArmLoaded', 1)], 1, DEPLOYMENT_A)
    await cacheENS('0xaaaa', 'alice.eth')

    await clearCache()

    const { events, lastBlock } = await getCachedEvents(DEPLOYMENT_A)
    expect(events).toEqual([])
    expect(lastBlock).toBe(0)

    const name = await getCachedENS('0xaaaa')
    expect(name).toBeNull()
  })
})
