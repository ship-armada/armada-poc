// ABOUTME: Unit tests for crowdfund alert rule evaluators (MONITORING.md §8 A1–A20).
// ABOUTME: Each rule is exercised in isolation with a synthetic AlertContext.

import { describe, expect, it } from 'vitest'
import {
  ruleA1, ruleA2, ruleA3, ruleA4, ruleA5, ruleA6, ruleA7, ruleA8,
  ruleA9a, ruleA9b, ruleA10, ruleA11, ruleA12, ruleA13, ruleA17, ruleA18, ruleA19, ruleA20,
  ruleAH1, ruleAH2,
  evaluateAllRules,
} from './rules.js'
import { ALERT_THRESHOLD_DEFAULTS } from './thresholds.js'
import type { AlertContext, CrowdfundParams } from './types.js'
import type { IndexerHealth, IndexerHealthStatus } from '../types.js'
import type { CrowdfundEvent } from '../../../shared/src/lib/events.js'
import type { AddressSummary, CrowdfundGraph, GraphEdge, GraphNode } from '../../../shared/src/lib/graph.js'

const HOP0_CAP = 15_000n * 10n ** 6n
const HOP1_CAP = 4_000n * 10n ** 6n

const OPEN_TS = 1_700_000_000
const WEEK1_TS = OPEN_TS + 7 * 24 * 60 * 60
const COMMIT_TS = OPEN_TS + 21 * 24 * 60 * 60

const PARAMS: CrowdfundParams = {
  chainId: 11155111,
  contractAddress: '0xcccc',
  treasuryAddress: '0xt',
  openTimestamp: OPEN_TS,
  week1Deadline: WEEK1_TS,
  commitmentDeadline: COMMIT_TS,
}

function emptyGraph(): CrowdfundGraph {
  return { nodes: new Map(), edges: [], summaries: new Map(), events: [] }
}

function makeNode(address: string, hop: number, committed: bigint, invitesReceived = 1): GraphNode {
  return {
    address,
    hop,
    invitesReceived,
    committed,
    rawDeposited: committed,
    invitedBy: [],
    invitesUsed: 0,
    invitesAvailable: 0,
    allocatedArm: null,
    acceptedUsdc: null,
  }
}

function makeEdge(fromAddress: string, fromHop: number, toAddress: string, toHop: number): GraphEdge {
  return { fromAddress, fromHop, toAddress, toHop }
}

function makeEvent(
  type: CrowdfundEvent['type'],
  args: Record<string, unknown> = {},
  blockNumber = 1,
  logIndex = 0,
): CrowdfundEvent {
  return {
    type,
    blockNumber,
    transactionHash: `0xtx${blockNumber}${logIndex}`,
    logIndex,
    args,
  }
}

function makeContext(overrides: Partial<AlertContext> = {}): AlertContext {
  const graph = overrides.snapshot?.graph ?? emptyGraph()
  const events = overrides.snapshot?.events ?? []
  return {
    now: OPEN_TS - 1,
    params: PARAMS,
    snapshot: {
      metadata: {
        schemaVersion: 1,
        chainId: PARAMS.chainId,
        contractAddress: PARAMS.contractAddress,
        deployBlock: 0,
        verifiedBlock: 100,
        verifiedBlockHash: '0xb',
        snapshotHash: '0xs',
        generatedAt: new Date(0).toISOString(),
        reconciliation: { status: 'pending', checkedBlock: null, provider: null, checkedAt: null, mismatches: [] },
      },
      events,
      graph,
    },
    health: {
      status: 'healthy',
      chainHead: 0, confirmedHead: 0, ingestedCursor: 0, verifiedCursor: 0, lagBlocks: 0,
      lastIngestedAt: null, lastVerifiedAt: null, lastReconciledAt: null,
      hasGaps: false, gapRanges: [], gapsRequiringIntervention: [],
      lastError: null, latestSnapshotHash: null, latestStaticSnapshotUrl: null,
    },
    thresholds: ALERT_THRESHOLD_DEFAULTS,
    treasuryUsdcBalance: null,
    finalizedAt: null,
    ...overrides,
  }
}

// ============ A1 ============
describe('ruleA1 — ARM loaded', () => {
  it('fires P3 once when ArmLoaded is present', () => {
    const ctx = makeContext({
      snapshot: { ...makeContext().snapshot, events: [makeEvent('ArmLoaded', {})] } as never,
    })
    const out = ruleA1(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'A1', severity: 'P3', dedupeKey: 'A1' })
  })
  it('does not fire when ArmLoaded absent', () => {
    expect(ruleA1(makeContext())).toEqual([])
  })
})

// ============ A2 ============
describe('ruleA2 — sale open, not armed', () => {
  it('fires P1 when now ≥ openTimestamp and no ArmLoaded', () => {
    const ctx = makeContext({ now: OPEN_TS + 1 })
    const out = ruleA2(ctx)
    expect(out[0]).toMatchObject({ id: 'A2', severity: 'P1' })
  })
  it('does not fire when armed', () => {
    const ctx = makeContext({
      now: OPEN_TS + 1,
      snapshot: { ...makeContext().snapshot, events: [makeEvent('ArmLoaded')] } as never,
    })
    expect(ruleA2(ctx)).toEqual([])
  })
  it('does not fire before openTimestamp', () => {
    expect(ruleA2(makeContext({ now: OPEN_TS - 1 }))).toEqual([])
  })
})

// ============ A3 ============
describe('ruleA3 — week-1 action after week1Deadline', () => {
  it('no-ops without event timestamps (current indexer state)', () => {
    const ctx = makeContext({
      now: WEEK1_TS + 100,
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('SeedAdded', { seed: '0xs' })],
      } as never,
    })
    expect(ruleA3(ctx)).toEqual([])
  })
  it('fires P0 when an event carries a _timestamp beyond week1Deadline', () => {
    const ctx = makeContext({
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('SeedAdded', { seed: '0xs', _timestamp: WEEK1_TS + 1 })],
      } as never,
    })
    const out = ruleA3(ctx)
    expect(out[0]).toMatchObject({ id: 'A3', severity: 'P0' })
  })
})

// ============ A4 ============
describe('ruleA4 — seed budget', () => {
  it('fires P2 at 80%', () => {
    const events = Array.from({ length: 128 }, (_, i) =>
      makeEvent('SeedAdded', { seed: `0x${i}` }, i + 1, 0),
    )
    const out = ruleA4(makeContext({ snapshot: { ...makeContext().snapshot, events } as never }))
    expect(out[0]).toMatchObject({ id: 'A4', severity: 'P2', dedupeKey: 'A4:80' })
  })
  it('fires P1 at 100%', () => {
    const events = Array.from({ length: 160 }, (_, i) =>
      makeEvent('SeedAdded', { seed: `0x${i}` }, i + 1, 0),
    )
    const out = ruleA4(makeContext({ snapshot: { ...makeContext().snapshot, events } as never }))
    expect(out[0]).toMatchObject({ id: 'A4', severity: 'P1', dedupeKey: 'A4:100' })
  })
  it('does not fire below 80%', () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent('SeedAdded', { seed: `0x${i}` }, i + 1, 0),
    )
    expect(ruleA4(makeContext({ snapshot: { ...makeContext().snapshot, events } as never }))).toEqual([])
  })
})

// ============ A5 ============
describe('ruleA5 — launch-team placements', () => {
  it('fires separately for hop-1 and hop-2 budgets', () => {
    const events = [
      ...Array.from({ length: 60 }, (_, i) => makeEvent('LaunchTeamInvited', { invitee: `0xa${i}`, hop: 1 }, i + 1, 0)),
      ...Array.from({ length: 48 }, (_, i) => makeEvent('LaunchTeamInvited', { invitee: `0xb${i}`, hop: 2 }, i + 200, 0)),
    ]
    const out = ruleA5(makeContext({ snapshot: { ...makeContext().snapshot, events } as never }))
    const ids = out.map((e) => e.dedupeKey).sort()
    expect(ids).toContain('A5:hop1:100')
    expect(ids).toContain('A5:hop2:80')
  })
})

// ============ A6 ============
describe('ruleA6 — duplicate same-hop slots', () => {
  it('fires P2 when duplicate ratio exceeds threshold', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 10; i++) {
      nodes.set(`a${i}-1`, makeNode(`0xa${i}`, 1, HOP1_CAP, i < 3 ? 2 : 1))
    }
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const out = ruleA6(makeContext({ snapshot: { ...makeContext().snapshot, graph } as never }))
    // 3/10 = 30% → bucketed to the 30% band (not the raw percent).
    expect(out[0]).toMatchObject({ id: 'A6', severity: 'P2', dedupeKey: 'A6:30' })
  })
  it('does not fire below threshold', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 100; i++) {
      nodes.set(`a${i}-1`, makeNode(`0xa${i}`, 1, HOP1_CAP, i < 2 ? 2 : 1))
    }
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    expect(ruleA6(makeContext({ snapshot: { ...makeContext().snapshot, graph } as never }))).toEqual([])
  })
})

// ============ A7 ============
describe('ruleA7 — expansion threshold', () => {
  it('fires at 80% of ELASTIC_TRIGGER', () => {
    const nodes = new Map<string, GraphNode>()
    // 80 seeds × $15k = $1.2M; ELASTIC_TRIGGER = $1.5M → 80%
    for (let i = 0; i < 80; i++) nodes.set(`a${i}-0`, makeNode(`0xa${i}`, 0, HOP0_CAP))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const out = ruleA7(makeContext({ snapshot: { ...makeContext().snapshot, graph } as never }))
    expect(out[0]).toMatchObject({ id: 'A7', dedupeKey: 'A7:80' })
  })
  it('fires at 100% with the highest crossed tier', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 100; i++) nodes.set(`a${i}-0`, makeNode(`0xa${i}`, 0, HOP0_CAP))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const out = ruleA7(makeContext({ snapshot: { ...makeContext().snapshot, graph } as never }))
    expect(out[0].dedupeKey).toBe('A7:100')
  })
})

// ============ A8 ============
describe('ruleA8 — minimum at risk late', () => {
  it('fires when sub-minimum with ≤72h left', () => {
    const nodes = new Map<string, GraphNode>()
    nodes.set('a-0', makeNode('0xa', 0, HOP0_CAP)) // $15k — far below MIN_SALE
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const ctx = makeContext({
      now: COMMIT_TS - 60 * 60 * 24 * 2, // 48h before deadline
      snapshot: { ...makeContext().snapshot, graph } as never,
    })
    const out = ruleA8(ctx)
    expect(out[0]).toMatchObject({ id: 'A8', dedupeKey: 'A8:72h' })
  })
  it('does not fire after deadline', () => {
    const ctx = makeContext({ now: COMMIT_TS + 1 })
    expect(ruleA8(ctx)).toEqual([])
  })
})

// ============ A9a / A9b ============
describe('ruleA9a — deadline passed, qualified', () => {
  it('fires P1 within grace, P0 beyond it', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 100; i++) nodes.set(`a${i}-0`, makeNode(`0xa${i}`, 0, HOP0_CAP))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const ctx = makeContext({
      now: COMMIT_TS + 60 * 60, // 1h past, within 2h grace
      snapshot: { ...makeContext().snapshot, graph } as never,
    })
    expect(ruleA9a(ctx)[0]).toMatchObject({ id: 'A9a', severity: 'P1', dedupeKey: 'A9a:P1' })
    const ctx2 = makeContext({
      now: COMMIT_TS + 60 * 60 * 3, // past grace
      snapshot: { ...makeContext().snapshot, graph } as never,
    })
    expect(ruleA9a(ctx2)[0]).toMatchObject({ severity: 'P0', dedupeKey: 'A9a:P0' })
  })
  it('does not fire after Finalized or Cancelled', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 100; i++) nodes.set(`a${i}-0`, makeNode(`0xa${i}`, 0, HOP0_CAP))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const ctx = makeContext({
      now: COMMIT_TS + 60 * 60,
      snapshot: {
        ...makeContext().snapshot,
        graph,
        events: [makeEvent('Finalized', { refundMode: false, saleSize: 0n, netProceeds: 0n }, 200)],
      } as never,
    })
    expect(ruleA9a(ctx)).toEqual([])
  })
})

describe('ruleA9b — deadline passed, sub-minimum', () => {
  it('fires P1', () => {
    const ctx = makeContext({ now: COMMIT_TS + 60 })
    expect(ruleA9b(ctx)[0]).toMatchObject({ id: 'A9b', severity: 'P1' })
  })
})

// ============ A10/A11/A12 ============
describe('finalization alerts', () => {
  it('A10 fires on refundMode=true', () => {
    const ctx = makeContext({
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('Finalized', { refundMode: true, saleSize: 0n, netProceeds: 0n }, 50)],
      } as never,
    })
    expect(ruleA10(ctx)[0]).toMatchObject({ id: 'A10', severity: 'P1' })
  })
  it('A11 fires on Cancelled', () => {
    const ctx = makeContext({
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('Cancelled', {}, 75)],
      } as never,
    })
    expect(ruleA11(ctx)[0]).toMatchObject({ id: 'A11', severity: 'P0' })
  })
  it('A12 fires on Finalized success', () => {
    const ctx = makeContext({
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('Finalized', { refundMode: false, saleSize: 1_800_000_000_000n, netProceeds: 1_000_000_000_000n }, 100)],
      } as never,
    })
    expect(ruleA12(ctx)[0]).toMatchObject({ id: 'A12', severity: 'P3' })
  })
})

// ============ A13 ============
describe('ruleA13 — treasury proceeds mismatch', () => {
  it('does not fire when balance matches netProceeds within rounding buffer', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 100; i++) nodes.set(`n${i}-0`, makeNode(`0xa${i}`, 0, 0n))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const ctx = makeContext({
      treasuryUsdcBalance: 1_000_000n,
      snapshot: {
        ...makeContext().snapshot,
        graph,
        events: [makeEvent('Finalized', { refundMode: false, netProceeds: 1_000_050n }, 100)],
      } as never,
    })
    // diff = 50, buffer = 100 (participantNodes count)
    expect(ruleA13(ctx)).toEqual([])
  })
  it('fires P0 when diff exceeds rounding buffer', () => {
    const nodes = new Map<string, GraphNode>()
    for (let i = 0; i < 10; i++) nodes.set(`n${i}-0`, makeNode(`0xa${i}`, 0, 0n))
    const graph: CrowdfundGraph = { ...emptyGraph(), nodes }
    const ctx = makeContext({
      treasuryUsdcBalance: 1_000_000n,
      snapshot: {
        ...makeContext().snapshot,
        graph,
        events: [makeEvent('Finalized', { refundMode: false, netProceeds: 999_500n }, 100)],
      } as never,
    })
    // diff = 500, buffer = 10 → fires
    expect(ruleA13(ctx)[0]).toMatchObject({ id: 'A13', severity: 'P0' })
  })
})

// ============ A17 ============
describe('ruleA17 — settlement after refundMode/cancel', () => {
  it('fires P0 when Allocated appears after refundMode', () => {
    const ctx = makeContext({
      snapshot: {
        ...makeContext().snapshot,
        events: [
          makeEvent('Finalized', { refundMode: true, saleSize: 0n, netProceeds: 0n }, 100),
          makeEvent('Allocated', { participant: '0xa', armTransferred: 1n, refundUsdc: 0n, delegate: '0xd' }, 101),
        ],
      } as never,
    })
    const out = ruleA17(ctx)
    expect(out[0]).toMatchObject({ id: 'A17', severity: 'P0' })
  })
})

// ============ A18 / A19 / A20 (time-gated) ============
describe('time-gated rules', () => {
  it('A18 fires when claim ratio under threshold after 14 days', () => {
    const events = [
      makeEvent('Finalized', { refundMode: false, saleSize: 0n, netProceeds: 0n }, 100),
      ...Array.from({ length: 10 }, (_, i) => makeEvent('Committed', { participant: `0xa${i}`, hop: 0, amount: HOP0_CAP }, 101 + i)),
      ...Array.from({ length: 2 }, (_, i) => makeEvent('Allocated', { participant: `0xa${i}`, armTransferred: 0n, refundUsdc: 0n, delegate: '0xd' }, 200 + i)),
    ]
    const ctx = makeContext({
      finalizedAt: OPEN_TS,
      now: OPEN_TS + 15 * 24 * 60 * 60,
      snapshot: { ...makeContext().snapshot, events } as never,
    })
    expect(ruleA18(ctx)[0]).toMatchObject({ id: 'A18' })
  })
  it('A19 fires when refund-claim shortfall exceeds threshold after 30 days', () => {
    const summaries = new Map<string, AddressSummary>()
    summaries.set('0xa', {
      address: '0xa',
      hops: [0],
      totalCommitted: HOP0_CAP,
      perHop: new Map(),
      displayInviter: 'armada',
      allocatedArm: null,
      refundUsdc: 1_000_000n, // refundable
      allocatedPerHop: new Map(),
      armClaimed: false,
      refundClaimed: false,
      delegate: null,
    })
    const graph: CrowdfundGraph = { ...emptyGraph(), summaries }
    const events = [
      makeEvent('Finalized', { refundMode: false, saleSize: 0n, netProceeds: 0n }, 100),
      // 80k of 1M claimed = 8% claimed, 92% unclaimed → above 10% threshold
      makeEvent('RefundClaimed', { participant: '0xa', usdcAmount: 80_000n }, 200),
    ]
    const ctx = makeContext({
      finalizedAt: OPEN_TS,
      now: OPEN_TS + 31 * 24 * 60 * 60,
      snapshot: { ...makeContext().snapshot, graph, events } as never,
    })
    expect(ruleA19(ctx)[0]).toMatchObject({ id: 'A19' })
  })
  it('A20 fires past 3-year window after success', () => {
    const ctx = makeContext({
      finalizedAt: OPEN_TS,
      now: OPEN_TS + 1095 * 24 * 60 * 60 + 1,
      snapshot: {
        ...makeContext().snapshot,
        events: [makeEvent('Finalized', { refundMode: false, saleSize: 0n, netProceeds: 0n }, 100)],
      } as never,
    })
    expect(ruleA20(ctx)[0]).toMatchObject({ id: 'A20' })
  })
})

// ============ Health gating + AH1/AH2 ============
function makeHealth(status: IndexerHealthStatus, overrides: Partial<IndexerHealth> = {}): IndexerHealth {
  return {
    status,
    chainHead: 0, confirmedHead: 0, ingestedCursor: 0, verifiedCursor: 0, lagBlocks: 0,
    lastIngestedAt: null, lastVerifiedAt: null, lastReconciledAt: null,
    hasGaps: false, gapRanges: [], gapsRequiringIntervention: [],
    lastError: null, latestSnapshotHash: null, latestStaticSnapshotUrl: null,
    ...overrides,
  }
}

describe('health gating of time-based rules', () => {
  it('suppresses A2/A8/A9a/A9b when the indexer is unhealthy', () => {
    const past = COMMIT_TS + 1
    const ctx = makeContext({ now: past, health: makeHealth('unhealthy') })
    expect(ruleA2(ctx)).toEqual([])
    expect(ruleA8(ctx)).toEqual([])
    expect(ruleA9a(ctx)).toEqual([])
    expect(ruleA9b(ctx)).toEqual([])
  })

  it('suppresses A2 when the indexer is stale but fires it when healthy', () => {
    expect(ruleA2(makeContext({ now: OPEN_TS + 1, health: makeHealth('stale') }))).toEqual([])
    expect(ruleA2(makeContext({ now: OPEN_TS + 1, health: makeHealth('healthy') }))[0]).toMatchObject({ id: 'A2' })
  })
})

describe('ruleAH1 — indexer health', () => {
  it('fires P1 with a date-bucketed dedupe key when unhealthy', () => {
    const ctx = makeContext({ health: makeHealth('unhealthy', { lastError: 'network: fetch failed' }) })
    const out = ruleAH1(ctx)
    expect(out[0]).toMatchObject({ id: 'AH1', severity: 'P1' })
    expect(out[0].dedupeKey).toMatch(/^AH1:unhealthy:\d{4}-\d{2}-\d{2}$/)
  })
  it('fires P2 when stale', () => {
    expect(ruleAH1(makeContext({ health: makeHealth('stale') }))[0]).toMatchObject({ id: 'AH1', severity: 'P2' })
  })
  it('does not fire when healthy or degraded', () => {
    expect(ruleAH1(makeContext({ health: makeHealth('healthy') }))).toEqual([])
    expect(ruleAH1(makeContext({ health: makeHealth('degraded') }))).toEqual([])
  })
})

describe('ruleAH2 — gaps requiring intervention', () => {
  it('fires P1 with the exhausted ranges in the dedupe key', () => {
    const ctx = makeContext({
      health: makeHealth('unhealthy', {
        gapsRequiringIntervention: [{ fromBlock: 100, toBlock: 199 }, { fromBlock: 300, toBlock: 399 }],
      }),
    })
    const out = ruleAH2(ctx)
    expect(out[0]).toMatchObject({ id: 'AH2', severity: 'P1' })
    expect(out[0].dedupeKey).toBe('AH2:100-199,300-399')
  })
  it('does not fire when there are no exhausted gaps', () => {
    expect(ruleAH2(makeContext({ health: makeHealth('degraded') }))).toEqual([])
  })
})

// ============ evaluateAllRules ============
describe('evaluateAllRules', () => {
  it('aggregates across all rules', () => {
    const ctx = makeContext({
      now: OPEN_TS + 1,
      snapshot: { ...makeContext().snapshot, events: [] } as never,
    })
    const out = evaluateAllRules(ctx)
    // A2 should fire (open, not armed); A9b only fires after deadline.
    expect(out.map((e) => e.id)).toContain('A2')
  })
})

// Reference imports to keep linter happy if rules are re-exported elsewhere.
void makeEdge
