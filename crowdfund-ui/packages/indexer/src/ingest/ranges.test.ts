// ABOUTME: Unit tests for no-gap range ingestion helper behavior.
// ABOUTME: Covers deterministic digests, gap detection, cursor promotion, and repair queue extraction.

import { describe, expect, it } from 'vitest'
import {
  createRangeDigest,
  findFirstGap,
  getContiguousVerifiedCursor,
  getLogIdentity,
  getRepairRanges,
} from './ranges.js'
import type { IndexedRawLog, IngestRangeRecord } from '../types.js'

function makeLog(overrides: Partial<IndexedRawLog> = {}): IndexedRawLog {
  return {
    chainId: 11155111,
    contractAddress: '0xF681A7c700420e5CA93f77c8988d3eED02767035',
    blockNumber: 10750000,
    blockHash: '0x' + '11'.repeat(32),
    transactionHash: '0x' + '22'.repeat(32),
    logIndex: 0,
    topics: ['0x' + '33'.repeat(32)],
    data: '0x',
    ...overrides,
  }
}

function makeRange(overrides: Partial<IngestRangeRecord>): IngestRangeRecord {
  return {
    fromBlock: 0,
    toBlock: 0,
    status: 'verified',
    provider: 'primary',
    attempts: 1,
    logCount: 0,
    digest: '0x',
    fetchedAt: '2026-04-28T00:00:00.000Z',
    verifiedAt: '2026-04-28T00:00:01.000Z',
    lastError: null,
    ...overrides,
  }
}

describe('range ingestion helpers', () => {
  it('builds stable log identities from canonical chain and log fields', () => {
    expect(getLogIdentity(makeLog())).toBe(
      [
        '11155111',
        '0xf681a7c700420e5ca93f77c8988d3eed02767035',
        '0x' + '11'.repeat(32),
        '10750000',
        '0x' + '22'.repeat(32),
        '0',
      ].join(':'),
    )
  })

  it('creates the same digest regardless of input order', () => {
    const first = makeLog({ blockNumber: 10, logIndex: 0 })
    const second = makeLog({
      blockNumber: 11,
      logIndex: 2,
      transactionHash: '0x' + '44'.repeat(32),
    })

    expect(createRangeDigest([second, first])).toBe(createRangeDigest([first, second]))
  })

  it('finds the first unverified gap inside a target block span', () => {
    const gap = findFirstGap(
      [
        { fromBlock: 100, toBlock: 110 },
        { fromBlock: 120, toBlock: 130 },
      ],
      100,
      130,
    )

    expect(gap).toEqual({ fromBlock: 111, toBlock: 119 })
  })

  it('promotes the verified cursor only through contiguous verified ranges', () => {
    const cursor = getContiguousVerifiedCursor(
      [
        makeRange({ fromBlock: 101, toBlock: 110, status: 'verified' }),
        makeRange({ fromBlock: 111, toBlock: 120, status: 'failed' }),
        makeRange({ fromBlock: 121, toBlock: 130, status: 'verified' }),
      ],
      100,
    )

    expect(cursor).toBe(110)
  })

  it('extracts failed and suspicious ranges for repair', () => {
    const repairRanges = getRepairRanges([
      makeRange({ fromBlock: 1, toBlock: 10, status: 'verified' }),
      makeRange({ fromBlock: 11, toBlock: 20, status: 'failed' }),
      makeRange({ fromBlock: 21, toBlock: 30, status: 'suspicious' }),
    ])

    expect(repairRanges).toEqual([
      { fromBlock: 11, toBlock: 20 },
      { fromBlock: 21, toBlock: 30 },
    ])
  })
})
