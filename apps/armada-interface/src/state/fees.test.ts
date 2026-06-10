// ABOUTME: Tests for feeQuoteIsStaleAtom (P1-28) — staleness is derived from the CLIENT-clock fetch time, not the server's expiresAt, so wall-clock skew can't produce a "always stale" re-quote storm.

import { describe, it, expect } from 'vitest'
import { createStore } from 'jotai'
import {
  feeQuoteAtom,
  feeQuoteFetchedAtAtom,
  feeQuoteIsStaleAtom,
  FEE_QUOTE_STALE_AFTER_MS,
} from './fees'
import { nowAtom } from './time'
import type { FeeSchedule } from '@/lib/relayer'

function quote(expiresAt: number): FeeSchedule {
  return {
    cacheId: 'c',
    expiresAt,
    chainId: 31337,
    broadcasterRailgunAddress: '',
    fees: { transfer: '0', unshield: '0', crossContract: '0', crossChainShield: '0', crossChainUnshield: '0', shield: '0', shieldXchain: '0' },
  }
}

describe('feeQuoteIsStaleAtom (P1-28)', () => {
  it('is stale when there is no quote', () => {
    const store = createStore()
    expect(store.get(feeQuoteIsStaleAtom)).toBe(true)
  })

  it('is fresh just after fetch and stale after the client-clock window — regardless of expiresAt skew', () => {
    const store = createStore()
    const t0 = 1_000_000_000
    store.set(nowAtom, t0)
    // Server clock is wildly behind (expiresAt already in the past by client reckoning): the OLD
    // expiresAt-vs-now check would read this as "always stale". Client-clock staleness ignores it.
    store.set(feeQuoteAtom, quote(t0 - 10 * 60_000))
    store.set(feeQuoteFetchedAtAtom, t0)

    expect(store.get(feeQuoteIsStaleAtom)).toBe(false)

    // Advance the (ticking) client clock — the atom recomputes because it depends on nowAtom.
    store.set(nowAtom, t0 + FEE_QUOTE_STALE_AFTER_MS - 1_000)
    expect(store.get(feeQuoteIsStaleAtom)).toBe(false)

    store.set(nowAtom, t0 + FEE_QUOTE_STALE_AFTER_MS + 1_000)
    expect(store.get(feeQuoteIsStaleAtom)).toBe(true)
  })

  it('is stale when a quote exists but no fetch time was recorded (defensive)', () => {
    const store = createStore()
    store.set(feeQuoteAtom, quote(Date.now() + 10 * 60_000))
    // feeQuoteFetchedAtAtom left null
    expect(store.get(feeQuoteIsStaleAtom)).toBe(true)
  })
})
