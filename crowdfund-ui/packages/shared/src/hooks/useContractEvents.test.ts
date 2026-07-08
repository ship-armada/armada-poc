// ABOUTME: Tests for the useContractEvents hook atoms and dedup logic.
// ABOUTME: Verifies event fetching pipeline, caching, and deduplication behavior.

import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'jotai'
import {
  crowdfundEventsAtom,
  lastFetchedBlockAtom,
  eventsLoadingAtom,
  eventsErrorAtom,
  mergePolledEvents,
  mergeReceiptEvents,
} from './useContractEvents.js'
import type { CrowdfundEvent } from '../lib/events.js'

function mkEvent(
  type: CrowdfundEvent['type'],
  blockNumber: number,
  logIndex = 0,
): CrowdfundEvent {
  return {
    type,
    blockNumber,
    transactionHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    logIndex,
    args: type === 'SeedAdded' ? { seed: '0x' + '01'.repeat(20) } : {},
  }
}

describe('useContractEvents atoms', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  describe('crowdfundEventsAtom', () => {
    it('defaults to empty array', () => {
      expect(store.get(crowdfundEventsAtom)).toEqual([])
    })

    it('stores events', () => {
      const events = [mkEvent('SeedAdded', 1), mkEvent('ArmLoaded', 2)]
      store.set(crowdfundEventsAtom, events)
      expect(store.get(crowdfundEventsAtom)).toHaveLength(2)
    })

    it('supports functional updates for dedup merging', () => {
      const initial = [mkEvent('SeedAdded', 1, 0)]
      store.set(crowdfundEventsAtom, initial)

      // Simulate the dedup merge pattern used in the hook
      store.set(crowdfundEventsAtom, (prev) => {
        const existing = new Set(prev.map((e) => `${e.transactionHash}-${e.logIndex}`))
        const newEvents = [
          mkEvent('SeedAdded', 1, 0), // duplicate
          mkEvent('ArmLoaded', 2, 0), // new
        ]
        const unique = newEvents.filter(
          (e) => !existing.has(`${e.transactionHash}-${e.logIndex}`),
        )
        return [...prev, ...unique]
      })

      const result = store.get(crowdfundEventsAtom)
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('SeedAdded')
      expect(result[1].type).toBe('ArmLoaded')
    })

    it('preserves event order (oldest first)', () => {
      store.set(crowdfundEventsAtom, [
        mkEvent('SeedAdded', 1),
        mkEvent('ArmLoaded', 2),
        mkEvent('Committed', 3),
      ])
      const events = store.get(crowdfundEventsAtom)
      expect(events[0].blockNumber).toBe(1)
      expect(events[1].blockNumber).toBe(2)
      expect(events[2].blockNumber).toBe(3)
    })
  })

  describe('lastFetchedBlockAtom', () => {
    it('defaults to 0', () => {
      expect(store.get(lastFetchedBlockAtom)).toBe(0)
    })

    it('tracks the last fetched block number', () => {
      store.set(lastFetchedBlockAtom, 42)
      expect(store.get(lastFetchedBlockAtom)).toBe(42)
    })
  })

  describe('eventsLoadingAtom', () => {
    it('defaults to true (loading on first mount)', () => {
      expect(store.get(eventsLoadingAtom)).toBe(true)
    })

    it('can be set to false when loading completes', () => {
      store.set(eventsLoadingAtom, false)
      expect(store.get(eventsLoadingAtom)).toBe(false)
    })
  })

  describe('eventsErrorAtom', () => {
    it('defaults to null', () => {
      expect(store.get(eventsErrorAtom)).toBeNull()
    })

    it('stores error messages', () => {
      store.set(eventsErrorAtom, 'RPC connection failed')
      expect(store.get(eventsErrorAtom)).toBe('RPC connection failed')
    })

    it('can be cleared', () => {
      store.set(eventsErrorAtom, 'some error')
      store.set(eventsErrorAtom, null)
      expect(store.get(eventsErrorAtom)).toBeNull()
    })
  })
})

describe('dedup logic', () => {
  it('deduplicates events with same txHash + logIndex', () => {
    const store = createStore()

    const event1 = mkEvent('SeedAdded', 10, 0)
    const event2 = mkEvent('ArmLoaded', 10, 1) // same block, different logIndex
    const event3 = mkEvent('SeedAdded', 10, 0) // exact duplicate of event1

    store.set(crowdfundEventsAtom, [event1, event2])

    store.set(crowdfundEventsAtom, (prev) => {
      const existing = new Set(prev.map((e) => `${e.transactionHash}-${e.logIndex}`))
      const incoming = [event3, mkEvent('Committed', 11, 0)]
      const unique = incoming.filter(
        (e) => !existing.has(`${e.transactionHash}-${e.logIndex}`),
      )
      return [...prev, ...unique]
    })

    const result = store.get(crowdfundEventsAtom)
    expect(result).toHaveLength(3) // event1, event2, Committed (event3 deduped)
  })

  it('keeps events with same txHash but different logIndex', () => {
    const store = createStore()
    const sameBlock = [
      mkEvent('SeedAdded', 5, 0),
      mkEvent('SeedAdded', 5, 1),
      mkEvent('ArmLoaded', 5, 2),
    ]
    store.set(crowdfundEventsAtom, sameBlock)
    expect(store.get(crowdfundEventsAtom)).toHaveLength(3)
  })
})

describe('mergePolledEvents', () => {
  it('advances the cursor to the resolved scan upper bound on an empty result', () => {
    const current = { events: [mkEvent('Committed', 10)], cursor: 10 }
    const { snapshot, unique } = mergePolledEvents(current, [], 25)
    // Cursor follows resolvedTo (25), not a later getBlockNumber; events unchanged.
    expect(snapshot.cursor).toBe(25)
    expect(snapshot.events).toEqual(current.events)
    expect(unique).toEqual([])
  })

  it('dedups new events against the current snapshot', () => {
    const current = { events: [mkEvent('Committed', 10, 0)], cursor: 10 }
    const incoming = [
      mkEvent('Committed', 10, 0), // duplicate of current
      mkEvent('Committed', 11, 0), // new
    ]
    const { snapshot, unique } = mergePolledEvents(current, incoming, 11)
    expect(snapshot.events).toHaveLength(2)
    expect(unique).toHaveLength(1)
    expect(unique[0].blockNumber).toBe(11)
  })

  it('never moves the cursor backwards', () => {
    const current = { events: [], cursor: 100 }
    const { snapshot } = mergePolledEvents(current, [], 50)
    expect(snapshot.cursor).toBe(100)
  })
})

describe('mergeReceiptEvents', () => {
  it('does not advance the cursor (re-fetch is idempotent)', () => {
    const prior = { events: [mkEvent('Committed', 10)], cursor: 10 }
    const receipt = [mkEvent('Committed', 14, 0)]
    const { snapshot, unique } = mergeReceiptEvents(prior, receipt, 0)
    // Cursor stays at 10 so the next poll re-scans 11..14 for other participants.
    expect(snapshot.cursor).toBe(10)
    expect(unique).toHaveLength(1)
    expect(snapshot.events).toHaveLength(2)
  })

  it('ignores receipt events already present and keeps chronological order', () => {
    const prior = { events: [mkEvent('Committed', 10, 0), mkEvent('Committed', 12, 0)], cursor: 12 }
    const receipt = [mkEvent('Committed', 11, 0), mkEvent('Committed', 10, 0)]
    const { snapshot, unique } = mergeReceiptEvents(prior, receipt, 0)
    expect(unique).toHaveLength(1) // only block 11 is new
    expect(snapshot.events.map((e) => e.blockNumber)).toEqual([10, 11, 12])
    expect(snapshot.cursor).toBe(12)
  })
})
