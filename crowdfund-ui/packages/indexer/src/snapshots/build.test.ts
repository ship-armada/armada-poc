// ABOUTME: Unit tests for building verified crowdfund snapshots from persisted raw logs.
// ABOUTME: Uses real ABI-encoded logs to verify parsing, graph building, and deterministic metadata.

import { Interface } from 'ethers'
import { describe, expect, it } from 'vitest'
import { CROWDFUND_ABI_FRAGMENTS } from '../../../shared/src/lib/constants.js'
import { buildSnapshot } from './build.js'
import type { IndexedRawLog, IndexerStoreData } from '../types.js'

const iface = new Interface(CROWDFUND_ABI_FRAGMENTS)
const participant = '0x1111111111111111111111111111111111111111'
const contractAddress = '0xF681A7c700420e5CA93f77c8988d3eED02767035'

function makeStoreData(rawLogs: readonly IndexedRawLog[]): IndexerStoreData {
  return {
    cursor: {
      deployBlock: 100,
      confirmationDepth: 12,
      overlapWindow: 100,
      chainHead: 150,
      confirmedHead: 138,
      ingestedCursor: 120,
      verifiedCursor: 110,
    },
    ranges: [],
    rawLogs,
    lastIngestedAt: null,
    lastVerifiedAt: null,
    lastReconciledAt: null,
    lastError: null,
    latestSnapshotHash: null,
    latestStaticSnapshotUrl: null,
  }
}

function makeLog(eventName: string, args: readonly unknown[], blockNumber: number): IndexedRawLog {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, args)
  return {
    chainId: 11155111,
    contractAddress,
    blockNumber,
    blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
    transactionHash: '0x' + (blockNumber + 1).toString(16).padStart(64, '0'),
    logIndex: 0,
    topics: encoded.topics,
    data: encoded.data,
  }
}

describe('buildSnapshot', () => {
  it('builds events and graph only through the verified cursor', () => {
    const snapshot = buildSnapshot({
      data: makeStoreData([
        makeLog('SeedAdded', [participant], 100),
        makeLog('Committed', [participant, 0, 1_000_000n], 105),
        makeLog('Committed', [participant, 0, 2_000_000n], 120),
      ]),
      chainId: 11155111,
      contractAddress,
    })

    const summary = snapshot.graph.summaries.get(participant)
    expect(snapshot.events).toHaveLength(2)
    expect(summary?.totalCommitted).toBe(1_000_000n)
    expect(snapshot.metadata.verifiedBlock).toBe(110)
    expect(snapshot.metadata.snapshotHash).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
