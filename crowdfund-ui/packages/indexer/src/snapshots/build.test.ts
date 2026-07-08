// ABOUTME: Unit tests for building verified crowdfund snapshots from persisted raw logs.
// ABOUTME: Uses real ABI-encoded logs to verify parsing, graph building, and deterministic metadata.

import { Interface } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { CROWDFUND_ABI_FRAGMENTS } from '../../../shared/src/lib/constants.js'
import { buildSnapshot, withReconciliation } from './build.js'
import type { IndexedRawLog, IndexerStoreData, ReconciliationResult } from '../types.js'

const iface = new Interface(CROWDFUND_ABI_FRAGMENTS)
const participant = '0x1111111111111111111111111111111111111111'
const contractAddress = '0xF681A7c700420e5CA93f77c8988d3eED02767035'

function makeStoreData(rawLogs: readonly IndexedRawLog[]): IndexerStoreData {
  return {
    cursor: {
      deployBlock: 100,
      confirmationDepth: 12,
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

  it('excludes logs from a different chain or contract', () => {
    const good = makeLog('SeedAdded', [participant], 100)
    const foreignContract = { ...makeLog('SeedAdded', [participant], 101), contractAddress: '0x' + 'ab'.repeat(20) }
    const foreignChain = { ...makeLog('Committed', [participant, 0, 5_000_000n], 102), chainId: 1 }
    const snapshot = buildSnapshot({
      data: makeStoreData([good, foreignContract, foreignChain]),
      chainId: 11155111,
      contractAddress,
    })
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0].type).toBe('SeedAdded')
  })

  it('produces a stable hash across wall-clock changes (content address)', () => {
    const data = makeStoreData([
      makeLog('SeedAdded', [participant], 100),
      makeLog('Committed', [participant, 0, 1_000_000n], 105),
    ])
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'))
      const a = buildSnapshot({ data, chainId: 11155111, contractAddress })
      vi.setSystemTime(new Date('2026-06-15T01:00:00.000Z'))
      const b = buildSnapshot({ data, chainId: 11155111, contractAddress })
      expect(a.metadata.generatedAt).not.toBe(b.metadata.generatedAt)
      expect(a.metadata.snapshotHash).toBe(b.metadata.snapshotHash)
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes the hash when verified events change', () => {
    const base = makeStoreData([makeLog('SeedAdded', [participant], 100)])
    const more = makeStoreData([
      makeLog('SeedAdded', [participant], 100),
      makeLog('Committed', [participant, 0, 1_000_000n], 105),
    ])
    const a = buildSnapshot({ data: base, chainId: 11155111, contractAddress })
    const b = buildSnapshot({ data: more, chainId: 11155111, contractAddress })
    expect(a.metadata.snapshotHash).not.toBe(b.metadata.snapshotHash)
  })

  it('withReconciliation swaps reconciliation without changing the hash or events', () => {
    const data = makeStoreData([makeLog('SeedAdded', [participant], 100)])
    const snapshot = buildSnapshot({ data, chainId: 11155111, contractAddress })
    const reconciliation: ReconciliationResult = {
      status: 'passed', checkedBlock: 110, provider: 'primary',
      checkedAt: '2026-06-15T00:00:00.000Z', mismatches: [],
    }
    const updated = withReconciliation(snapshot, reconciliation)
    expect(updated.metadata.snapshotHash).toBe(snapshot.metadata.snapshotHash)
    expect(updated.metadata.reconciliation.status).toBe('passed')
    expect(updated.events).toBe(snapshot.events)
  })
})
