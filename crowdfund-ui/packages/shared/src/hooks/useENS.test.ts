// ABOUTME: Tests for the useENS hook's underlying atom and resolution logic.
// ABOUTME: Verifies ENS map atom behavior and address display name formatting.

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import { ensMapAtom } from './useENS.js'
import { truncateAddress } from '../lib/format.js'

const ADDR = {
  alice: '0x' + 'aa'.repeat(20),
  bob: '0x' + 'bb'.repeat(20),
  carol: '0x' + 'cc'.repeat(20),
}

describe('ensMapAtom', () => {
  it('defaults to empty map', () => {
    const store = createStore()
    expect(store.get(ensMapAtom).size).toBe(0)
  })

  it('stores address → ENS name mappings', () => {
    const store = createStore()
    const map = new Map([
      [ADDR.alice.toLowerCase(), 'alice.eth'],
      [ADDR.bob.toLowerCase(), 'bob.eth'],
    ])
    store.set(ensMapAtom, map)

    const result = store.get(ensMapAtom)
    expect(result.get(ADDR.alice.toLowerCase())).toBe('alice.eth')
    expect(result.get(ADDR.bob.toLowerCase())).toBe('bob.eth')
  })

  it('supports incremental updates via functional set', () => {
    const store = createStore()

    // Initial batch
    store.set(ensMapAtom, new Map([[ADDR.alice.toLowerCase(), 'alice.eth']]))

    // Add more names
    store.set(ensMapAtom, (prev) => {
      const next = new Map(prev)
      next.set(ADDR.bob.toLowerCase(), 'bob.eth')
      return next
    })

    const result = store.get(ensMapAtom)
    expect(result.size).toBe(2)
    expect(result.get(ADDR.alice.toLowerCase())).toBe('alice.eth')
    expect(result.get(ADDR.bob.toLowerCase())).toBe('bob.eth')
  })

  it('returns undefined for unresolved addresses', () => {
    const store = createStore()
    store.set(ensMapAtom, new Map([[ADDR.alice.toLowerCase(), 'alice.eth']]))

    const result = store.get(ensMapAtom)
    expect(result.get(ADDR.carol.toLowerCase())).toBeUndefined()
  })
})

describe('displayName pattern (resolve + truncate fallback)', () => {
  it('returns ENS name when available', () => {
    const ensMap = new Map([[ADDR.alice.toLowerCase(), 'alice.eth']])
    const displayName = (addr: string) =>
      ensMap.get(addr.toLowerCase()) ?? truncateAddress(addr)

    expect(displayName(ADDR.alice)).toBe('alice.eth')
  })

  it('falls back to truncated address when no ENS name', () => {
    const ensMap = new Map<string, string>()
    const displayName = (addr: string) =>
      ensMap.get(addr.toLowerCase()) ?? truncateAddress(addr)

    const result = displayName(ADDR.bob)
    expect(result).toMatch(/^0x/)
    expect(result.length).toBeLessThan(ADDR.bob.length)
    expect(result).toContain('...')
  })

  it('is case-insensitive for address lookup', () => {
    const ensMap = new Map([[ADDR.alice.toLowerCase(), 'alice.eth']])
    const resolve = (addr: string) => ensMap.get(addr.toLowerCase()) ?? null

    // Mixed case should still resolve
    expect(resolve(ADDR.alice.toUpperCase())).toBe('alice.eth')
    expect(resolve(ADDR.alice.toLowerCase())).toBe('alice.eth')
  })
})
