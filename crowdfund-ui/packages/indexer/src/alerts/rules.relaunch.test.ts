// ABOUTME: Alert-rule and graph tests under the relaunch profile (CROWDFUND_PROFILE=relaunch).
// ABOUTME: Loads the rules with that profile via a module reset, since the shared constants resolve at import.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALERT_THRESHOLD_DEFAULTS } from './thresholds.js'
import type { AlertContext, AlertRule } from './types.js'
import type { CrowdfundEvent } from '../../../shared/src/lib/events.js'
import type { CrowdfundGraph, GraphNode } from '../../../shared/src/lib/graph.js'

const USDC = 10n ** 6n
const KNOWN_CAP = 100_000n * USDC
const INVITED_CAP = 10_000n * USDC

type RulesModule = typeof import('./rules.js')
type GraphModule = typeof import('../../../shared/src/lib/graph.js')
let rules: RulesModule
let graphLib: GraphModule

beforeAll(async () => {
  vi.stubEnv('CROWDFUND_PROFILE', 'relaunch')
  vi.resetModules()
  const constants = await import('../../../shared/src/lib/constants.js')
  // Guard: if the profile did not take effect, every assertion below would test mainnet values.
  expect(constants.CROWDFUND_PROFILE).toBe('relaunch')
  rules = await import('./rules.js')
  graphLib = await import('../../../shared/src/lib/graph.js')
})

afterAll(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

function makeNode(address: string, hop: number, committed: bigint, invitesReceived = 1): GraphNode {
  return {
    address, hop, invitesReceived, committed, rawDeposited: committed, invitedBy: [],
    invitesUsed: 0, invitesAvailable: 0, allocatedArm: null, acceptedUsdc: null,
  }
}

function graphOf(nodes: GraphNode[]): CrowdfundGraph {
  return {
    nodes: new Map(nodes.map((n) => [`${n.address}-${n.hop}`, n])),
    edges: [], summaries: new Map(), events: [],
  }
}

function makeEvent(type: CrowdfundEvent['type'], args: Record<string, unknown>, blockNumber: number): CrowdfundEvent {
  return { type, blockNumber, transactionHash: `0xtx${blockNumber}`, logIndex: 0, args }
}

function context(graph: CrowdfundGraph, events: CrowdfundEvent[] = []): AlertContext {
  return {
    now: 0,
    params: {
      chainId: 1, contractAddress: '0xcccc', treasuryAddress: '0xt',
      openTimestamp: 1, week1Deadline: 2, commitmentDeadline: 3,
    },
    snapshot: {
      metadata: {
        schemaVersion: 1, chainId: 1, contractAddress: '0xcccc', deployBlock: 0, verifiedBlock: 100,
        verifiedBlockHash: '0xb', snapshotHash: '0xs', generatedAt: new Date(0).toISOString(),
        reconciliation: { status: 'pending', checkedBlock: null, provider: null, checkedAt: null, mismatches: [] },
      },
      events,
      graph,
    },
    health: {
      status: 'healthy', chainHead: 0, confirmedHead: 0, ingestedCursor: 0, verifiedCursor: 0, lagBlocks: 0,
      lastIngestedAt: null, lastVerifiedAt: null, lastReconciledAt: null, hasGaps: false, gapRanges: [],
      gapsRequiringIntervention: [], lastError: null, latestSnapshotHash: null, latestStaticSnapshotUrl: null,
    },
    thresholds: ALERT_THRESHOLD_DEFAULTS,
    treasuryUsdcBalance: null,
    finalizedAt: null,
  } as AlertContext
}

function run(rule: (m: RulesModule) => AlertRule, ctx: AlertContext) {
  return rule(rules)(ctx)
}

describe('graph under the relaunch profile', () => {
  // WHY: the graph caps each node's committed amount at its hop cap. Under the Launch 1 caps a
  // $100k Backer deposit was clamped to $15k, corrupting snapshots, demand alerts and reconciliation.
  it('caps a Backer deposit at $100k and a Community deposit at $10k', () => {
    const graph = graphLib.buildGraph([
      makeEvent('SeedAdded', { seed: '0xaaa' }, 1),
      makeEvent('Committed', { participant: '0xaaa', hop: 0, amount: 200_000n * USDC }, 2),
      makeEvent('LaunchTeamInvited', { invitee: '0xbbb', hop: 2 }, 3),
      makeEvent('Invited', { inviter: '0x0000000000000000000000000000000000000000', invitee: '0xbbb', hop: 2, nonce: 0n }, 3),
      makeEvent('Committed', { participant: '0xbbb', hop: 2, amount: 12_000n * USDC }, 4),
    ])
    const committed = [...graph.nodes.values()].map((n) => [n.address.toLowerCase(), n.hop, n.committed])
    expect(committed).toContainEqual(['0xaaa', 0, KNOWN_CAP])
    expect(committed).toContainEqual(['0xbbb', 2, INVITED_CAP])
  })
})

describe('A4/A5 budgets under the relaunch profile', () => {
  // WHY: the relaunch budgets are 500 seeds, 1 team wallet and 500 Community placements; the alerts
  // must measure against those, not Launch 1's 180/100/120.
  it('A4 fires at 80% of the 500-seed budget', () => {
    const events = Array.from({ length: 400 }, (_, i) => makeEvent('SeedAdded', { seed: `0x${i}` }, i + 1))
    const out = run((m) => m.ruleA4, context(graphOf([]), events))
    expect(out[0]).toMatchObject({ id: 'A4', dedupeKey: 'A4:80' })
    expect(out[0].title).toContain('400/500')
  })

  it('A5 measures the team wallet against 1 and Community placements against 500, naming the tiers', () => {
    const events = [
      makeEvent('LaunchTeamInvited', { invitee: '0xa0', hop: 1 }, 1),
      ...Array.from({ length: 400 }, (_, i) => makeEvent('LaunchTeamInvited', { invitee: `0xb${i}`, hop: 2 }, i + 100)),
    ]
    const out = run((m) => m.ruleA5, context(graphOf([]), events))
    const team = out.find((e) => e.dedupeKey === 'A5:hop1:100')
    const invited = out.find((e) => e.dedupeKey === 'A5:hop2:80')
    expect(team?.title).toContain('Team')
    expect(team?.body).toContain('1/1')
    expect(invited?.title).toContain('Community')
    expect(invited?.body).toContain('400/500')
  })
})

describe('A6 under the relaunch profile (hop-2 stacking up to 20)', () => {
  // WHY: Community contributors may stack up to 20 invites, so a stacked node is intended, not a
  // configuration error. A6 stays an awareness alert: silent for a few stacked nodes, firing once
  // the stacked share reaches the threshold (MONITORING.md A6 / §9.1).
  it('stays silent for a single stacked node and fires at the ratio threshold', () => {
    const one = Array.from({ length: 100 }, (_, i) => makeNode(`0xa${i}`, 2, INVITED_CAP, i === 0 ? 2 : 1))
    expect(run((m) => m.ruleA6, context(graphOf(one)))).toEqual([])
    const ten = Array.from({ length: 100 }, (_, i) => makeNode(`0xa${i}`, 2, INVITED_CAP, i < 10 ? 20 : 1))
    const out = run((m) => m.ruleA6, context(graphOf(ten)))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'A6', dedupeKey: 'A6:10' })
  })

  it('does not fire when every node holds one slot', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`0xa${i}`, 2, INVITED_CAP))
    expect(run((m) => m.ruleA6, context(graphOf(nodes)))).toEqual([])
  })
})

describe('A7 under the relaunch profile (no expansion)', () => {
  // WHY: BASE_SALE == MAX_SALE, so crossing the trigger expands nothing; the alert still marks how
  // close the $1.8M sale is to fully subscribed and must not talk about expansion or crowd-out.
  it('reports subscription of the $1.8M sale without expansion wording', () => {
    const nodes = Array.from({ length: 15 }, (_, i) => makeNode(`0xa${i}`, 0, KNOWN_CAP)) // $1.5M = 83%
    const out = run((m) => m.ruleA7, context(graphOf(nodes)))
    expect(out[0]).toMatchObject({ id: 'A7', dedupeKey: 'A7:80' })
    expect(out[0].title).toContain('80% of the sale size')
    expect(`${out[0].title} ${out[0].body}`).not.toMatch(/expan|ELASTIC_TRIGGER|crowded/i)
  })
})

describe('A13 launch-team payment checks under the relaunch profile', () => {
  // A finalized sale of $1M net proceeds with 10 participant nodes (rounding buffer ≤ 10 units).
  const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`0xa${i}`, 0, KNOWN_CAP))
  const finalized = makeEvent('Finalized', { refundMode: false, netProceeds: 1_000_000n * USDC }, 100)
  function a13(events: CrowdfundEvent[], treasuryUsdcBalance: bigint) {
    return run((m) => m.ruleA13, { ...context(graphOf(nodes), events), treasuryUsdcBalance })
  }

  // WHY: the relaunch contract always pays the launch team at a successful finalize; a missing
  // LaunchTeamPaid means the deployed contract or the indexer's event set differs (MONITORING.md A13).
  it('fires when LaunchTeamPaid is missing', () => {
    const out = a13([finalized], 750_000n * USDC)
    expect(out[0]).toMatchObject({ id: 'A13', severity: 'P0' })
    expect(out[0].body).toContain('LaunchTeamPaid')
  })

  // WHY: the payment is exactly TEAM_PAYMENT_USDC ($250K) unless the proceeds are smaller.
  it('fires when the payment is not $250K though the proceeds cover it', () => {
    const paid = makeEvent('LaunchTeamPaid', { recipient: '0xteam', amount: 200_000n * USDC }, 100)
    const out = a13([paid, finalized], 800_000n * USDC)
    expect(out[0]).toMatchObject({ id: 'A13', severity: 'P0' })
    expect(out[0].body).toContain('launch-team payment')
  })

  it('stays silent for the exact $250K payment and matching treasury proceeds', () => {
    const paid = makeEvent('LaunchTeamPaid', { recipient: '0xteam', amount: 250_000n * USDC }, 100)
    expect(a13([paid, finalized], 750_000n * USDC - 7n)).toEqual([])
  })

  // WHY: at the minimum raise the whole distributable amount (proceeds less the buffer) goes to
  // the team, so a payment just below $250K is correct there.
  it('accepts a payment below $250K when it is the whole distributable amount', () => {
    const small = makeEvent('Finalized', { refundMode: false, netProceeds: 250_000n * USDC }, 100)
    const paid = makeEvent('LaunchTeamPaid', { recipient: '0xteam', amount: 250_000n * USDC - 10n }, 100)
    expect(a13([paid, small], 0n)).toEqual([])
  })
})
