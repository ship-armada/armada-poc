// ABOUTME: Tests for the useSelection hook and its underlying Jotai atoms.
// ABOUTME: Verifies selection state coordination between tree and table views.

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import { selectedAddressAtom, searchQueryAtom } from './useSelection.js'

describe('selectedAddressAtom', () => {
  it('defaults to null', () => {
    const store = createStore()
    expect(store.get(selectedAddressAtom)).toBeNull()
  })

  it('stores and retrieves an address', () => {
    const store = createStore()
    store.set(selectedAddressAtom, '0x1234')
    expect(store.get(selectedAddressAtom)).toBe('0x1234')
  })

  it('can be cleared back to null', () => {
    const store = createStore()
    store.set(selectedAddressAtom, '0xabc')
    store.set(selectedAddressAtom, null)
    expect(store.get(selectedAddressAtom)).toBeNull()
  })
})

describe('searchQueryAtom', () => {
  it('defaults to empty string', () => {
    const store = createStore()
    expect(store.get(searchQueryAtom)).toBe('')
  })

  it('stores and retrieves a search query', () => {
    const store = createStore()
    store.set(searchQueryAtom, 'alice.eth')
    expect(store.get(searchQueryAtom)).toBe('alice.eth')
  })

  it('can be cleared back to empty', () => {
    const store = createStore()
    store.set(searchQueryAtom, 'search term')
    store.set(searchQueryAtom, '')
    expect(store.get(searchQueryAtom)).toBe('')
  })
})

describe('atom independence', () => {
  it('selectedAddress and searchQuery are independent', () => {
    const store = createStore()
    store.set(selectedAddressAtom, '0xabc')
    store.set(searchQueryAtom, 'query')

    expect(store.get(selectedAddressAtom)).toBe('0xabc')
    expect(store.get(searchQueryAtom)).toBe('query')

    store.set(selectedAddressAtom, null)
    expect(store.get(searchQueryAtom)).toBe('query')
  })
})
