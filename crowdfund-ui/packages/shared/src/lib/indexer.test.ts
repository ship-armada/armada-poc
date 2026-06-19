// ABOUTME: Tests for browser-side indexer snapshot client helpers.
// ABOUTME: Verifies JSON snapshot events are revived into graph-compatible bigint values.

import { describe, expect, it } from 'vitest'
import { fetchIndexerHealth, reviveIndexedEvent } from './indexer.js'

describe('reviveIndexedEvent', () => {
  it('revives bigint fields used by graph construction', () => {
    const event = reviveIndexedEvent({
      type: 'Committed',
      blockNumber: 100,
      transactionHash: '0xabc',
      logIndex: 0,
      args: {
        participant: '0x1111111111111111111111111111111111111111',
        hop: 0,
        amount: '1000000',
      },
    })

    expect(event.args.amount).toBe(1_000_000n)
  })

  it('revives an event type with no bigint args', () => {
    const event = reviveIndexedEvent({
      type: 'Cancelled',
      blockNumber: 5,
      transactionHash: '0xabc',
      logIndex: 1,
      args: {},
    })
    expect(event.type).toBe('Cancelled')
  })

  it('throws on an unknown event type', () => {
    expect(() =>
      reviveIndexedEvent({
        type: 'NotARealEvent',
        blockNumber: 1,
        transactionHash: '0xabc',
        logIndex: 0,
        args: {},
      }),
    ).toThrow(/unknown type/)
  })

  it('throws when a required bigint field is missing', () => {
    expect(() =>
      reviveIndexedEvent({
        type: 'Committed',
        blockNumber: 1,
        transactionHash: '0xabc',
        logIndex: 0,
        args: { participant: '0x1', hop: 0 }, // no amount
      }),
    ).toThrow(/amount/)
  })

  it('throws when a bigint field is not a numeric string', () => {
    expect(() =>
      reviveIndexedEvent({
        type: 'Committed',
        blockNumber: 1,
        transactionHash: '0xabc',
        logIndex: 0,
        args: { participant: '0x1', hop: 0, amount: 'not-a-number' },
      }),
    ).toThrow(/amount/)
  })

  it('throws on a non-object / missing args', () => {
    expect(() => reviveIndexedEvent(null)).toThrow(/Invalid indexed event/)
    expect(() =>
      reviveIndexedEvent({ type: 'Cancelled', blockNumber: 1, transactionHash: '0xabc', logIndex: 0 }),
    ).toThrow(/args/)
  })

  it('fetches indexer health status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'stale',
      chainHead: 120,
      confirmedHead: 110,
      ingestedCursor: 110,
      verifiedCursor: 100,
      lagBlocks: 10,
      lastIngestedAt: null,
      lastVerifiedAt: null,
      lastReconciledAt: null,
      hasGaps: false,
      gapRanges: [],
      lastError: null,
      latestSnapshotHash: null,
      latestStaticSnapshotUrl: null,
    }))) as typeof fetch

    try {
      await expect(fetchIndexerHealth('https://indexer.example/')).resolves.toMatchObject({
        status: 'stale',
        verifiedCursor: 100,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
