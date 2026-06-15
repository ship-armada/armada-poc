// ABOUTME: Unit tests for the alert evaluator — dispatch, dedupe, state persistence.
// ABOUTME: Uses in-memory notifier and state store; no external IO.

import { describe, expect, it, vi } from 'vitest'
import { evaluateAndDispatch } from './evaluator.js'
import { createInMemoryNotifier, type Notifier } from './notifier.js'
import { createInMemoryAlertStateStore } from './state.js'
import type { AlertContext, AlertEvent } from './types.js'

const MINIMAL_CTX: AlertContext = {
  now: 0,
  params: {
    chainId: 1, contractAddress: '0xc', treasuryAddress: '0xt',
    openTimestamp: 0, week1Deadline: 0, commitmentDeadline: 0,
  },
  snapshot: {
    metadata: {
      schemaVersion: 1, chainId: 1, contractAddress: '0xc',
      deployBlock: 0, verifiedBlock: 0, verifiedBlockHash: '0x',
      snapshotHash: '0x', generatedAt: new Date(0).toISOString(),
      reconciliation: { status: 'pending', checkedBlock: null, provider: null, checkedAt: null, mismatches: [] },
    },
    events: [],
    graph: { nodes: new Map(), edges: [], summaries: new Map(), events: [] },
  },
  health: {
    status: 'healthy',
    chainHead: 0, confirmedHead: 0, ingestedCursor: 0, verifiedCursor: 0, lagBlocks: 0,
    lastIngestedAt: null, lastVerifiedAt: null, lastReconciledAt: null,
    hasGaps: false, gapRanges: [], gapsRequiringIntervention: [],
    lastError: null, latestSnapshotHash: null, latestStaticSnapshotUrl: null,
  },
  thresholds: {
    duplicateSlotFraction: 0.10,
    finalizeGraceSeconds: 7200,
    claimParticipationFloor: 0.5,
    refundUnclaimedThreshold: 0.1,
  },
  treasuryUsdcBalance: null,
  finalizedAt: null,
}

const SAMPLE_A1: AlertEvent = {
  id: 'A1', severity: 'P3', dedupeKey: 'A1', title: 'arm', body: 'b', runbook: 'r',
}
const SAMPLE_A11: AlertEvent = {
  id: 'A11', severity: 'P0', dedupeKey: 'A11', title: 'cancel', body: 'b', runbook: 'r',
}

describe('evaluateAndDispatch', () => {
  it('delivers each alert once across runs', async () => {
    const notifier = createInMemoryNotifier()
    const state = createInMemoryAlertStateStore()
    const evaluate = () => [SAMPLE_A1, SAMPLE_A11]

    const first = await evaluateAndDispatch({ context: MINIMAL_CTX, notifier, stateStore: state, evaluate })
    expect(first.delivered.map((e) => e.id)).toEqual(['A1', 'A11'])
    expect(first.skipped).toEqual([])

    const second = await evaluateAndDispatch({ context: MINIMAL_CTX, notifier, stateStore: state, evaluate })
    expect(second.delivered).toEqual([])
    expect(second.skipped.map((e) => e.id)).toEqual(['A1', 'A11'])

    // Notifier should have received exactly two distinct sends total.
    expect(notifier.events.map((e) => e.dedupeKey)).toEqual(['A1', 'A11'])
  })

  it('dedupe keys are per-tier — same alert, different tier, delivers separately', async () => {
    const notifier = createInMemoryNotifier()
    const state = createInMemoryAlertStateStore()
    const tier80: AlertEvent = { id: 'A4', severity: 'P2', dedupeKey: 'A4:80', title: 't', body: 'b', runbook: 'r' }
    const tier100: AlertEvent = { id: 'A4', severity: 'P1', dedupeKey: 'A4:100', title: 't', body: 'b', runbook: 'r' }

    const first = await evaluateAndDispatch({
      context: MINIMAL_CTX, notifier, stateStore: state,
      evaluate: () => [tier80],
    })
    expect(first.delivered).toHaveLength(1)

    const second = await evaluateAndDispatch({
      context: MINIMAL_CTX, notifier, stateStore: state,
      evaluate: () => [tier80, tier100],
    })
    expect(second.delivered).toHaveLength(1)
    expect(second.delivered[0].dedupeKey).toBe('A4:100')
  })

  it('survives a mid-loop delivery failure and re-attempts only the failed alert', async () => {
    const sampleA4: AlertEvent = { id: 'A4', severity: 'P2', dedupeKey: 'A4:80', title: 't', body: 'b', runbook: 'r' }
    const delivered: string[] = []
    // Notifier that throws for A11 only; succeeds for everything else.
    let failA11 = true
    const notifier: Notifier = {
      async send(event) {
        if (event.dedupeKey === 'A11' && failA11) throw new Error('Discord webhook P0 returned 503: unavailable')
        delivered.push(event.dedupeKey)
      },
    }
    const state = createInMemoryAlertStateStore()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const evaluate = () => [SAMPLE_A1, SAMPLE_A11, sampleA4]
      const first = await evaluateAndDispatch({ context: MINIMAL_CTX, notifier, stateStore: state, evaluate })

      expect(first.delivered.map((e) => e.dedupeKey)).toEqual(['A1', 'A4:80'])
      expect(first.failed.map((e) => e.dedupeKey)).toEqual(['A11'])
      // The two successes were persisted despite A11 throwing in between them.
      expect(Array.from((await state.read()).firedKeys).sort()).toEqual(['A1', 'A4:80'])

      // Next tick with a healthy webhook re-attempts only the previously-failed A11.
      failA11 = false
      const second = await evaluateAndDispatch({ context: MINIMAL_CTX, notifier, stateStore: state, evaluate })
      expect(second.delivered.map((e) => e.dedupeKey)).toEqual(['A11'])
      expect(second.skipped.map((e) => e.dedupeKey)).toEqual(['A1', 'A4:80'])
      expect(second.failed).toEqual([])
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('persists state only when delivering at least one alert', async () => {
    const notifier = createInMemoryNotifier()
    const writes: Array<ReadonlySet<string>> = []
    const state = {
      async read() { return { firedKeys: new Set<string>() } },
      async write(next: { firedKeys: ReadonlySet<string> }) { writes.push(next.firedKeys) },
    }
    await evaluateAndDispatch({ context: MINIMAL_CTX, notifier, stateStore: state, evaluate: () => [] })
    expect(writes).toEqual([])
  })
})
