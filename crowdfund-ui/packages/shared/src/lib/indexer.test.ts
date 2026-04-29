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
