// ABOUTME: Pure alert-rule evaluators for MONITORING.md §8 A1–A20.
// ABOUTME: Each rule returns 0..n AlertEvent occurrences given the current context.

import { CROWDFUND_CONSTANTS } from '../../../shared/src/lib/constants.js'
import type { CrowdfundEvent } from '../../../shared/src/lib/events.js'
import type { CrowdfundGraph } from '../../../shared/src/lib/graph.js'
import type { AlertContext, AlertEvent, AlertRule } from './types.js'

const TIER_LEVELS = [80, 90, 100] as const
const EXPANSION_TIERS = [80, 90, 95, 100] as const

// ============ Generic helpers ============

function eventsOfType(events: readonly CrowdfundEvent[], type: CrowdfundEvent['type']): readonly CrowdfundEvent[] {
  return events.filter((e) => e.type === type)
}

function cappedDemandTotal(graph: CrowdfundGraph): bigint {
  let total = 0n
  for (const node of graph.nodes.values()) total += node.committed
  return total
}

function duplicateSlotNodeCount(graph: CrowdfundGraph): number {
  let count = 0
  for (const node of graph.nodes.values()) {
    if (node.hop >= 1 && node.invitesReceived > 1) count++
  }
  return count
}

function occupiedHop12Count(graph: CrowdfundGraph): number {
  let count = 0
  for (const node of graph.nodes.values()) if (node.hop === 1 || node.hop === 2) count++
  return count
}

function uniqueCommittedAddressCount(events: readonly CrowdfundEvent[]): number {
  const set = new Set<string>()
  for (const e of events) {
    if (e.type === 'Committed') set.add(String(e.args.participant).toLowerCase())
  }
  return set.size
}

function countLaunchTeamPlacementsAtHop(events: readonly CrowdfundEvent[], hop: number): number {
  return events.filter((e) => e.type === 'LaunchTeamInvited' && Number(e.args.hop) === hop).length
}

function nearestCrossedTier(value: number, target: number, tiers: readonly number[]): number | null {
  if (target <= 0) return null
  let crossed: number | null = null
  for (const t of tiers) {
    if ((value * 100) / target >= t) crossed = t
  }
  return crossed
}

function findLatestEvent(
  events: readonly CrowdfundEvent[],
  type: CrowdfundEvent['type'],
): CrowdfundEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i]
  }
  return null
}

function severityForBudget(crossedTier: number): 'P1' | 'P2' {
  return crossedTier >= 100 ? 'P1' : 'P2'
}

// Time-vs-event rules compare wall-clock `now` against *indexed* events. When the
// indexer is stale or unhealthy the snapshot may be missing recent events, so those
// rules would fire false positives (e.g. "finalize required" because the Finalized
// event has not been ingested yet). Suppress them in that case; AH1 separately pages
// that the indexer itself is degraded.
function isSnapshotTrustworthy(ctx: AlertContext): boolean {
  return ctx.health.status !== 'unhealthy' && ctx.health.status !== 'stale'
}

// UTC calendar-day bucket (YYYY-MM-DD) derived from the injected clock. Used in
// health-alert dedupe keys so a persistent outage re-pages once per day rather than on
// every cron tick (dedupe keys persist forever with no resolve/re-arm mechanism).
function utcDateBucket(nowSeconds: number): string {
  return new Date(nowSeconds * 1000).toISOString().slice(0, 10)
}

// ============ Rule implementations ============

// A1 — ARM loaded (P3, once)
export const ruleA1: AlertRule = (ctx) => {
  const event = findLatestEvent(ctx.snapshot.events, 'ArmLoaded')
  if (!event) return []
  return [{
    id: 'A1',
    severity: 'P3',
    dedupeKey: 'A1',
    title: 'ARM loaded',
    body: `ArmLoaded emitted at block ${event.blockNumber}. Commitment window opens at openTimestamp.`,
    runbook: 'OPERATIONS.md §3 Steps 5–8',
  }]
}

// A2 — Sale should be open but not yet armed (P1)
export const ruleA2: AlertRule = (ctx) => {
  if (!isSnapshotTrustworthy(ctx)) return []
  if (ctx.now < ctx.params.openTimestamp) return []
  const armed = eventsOfType(ctx.snapshot.events, 'ArmLoaded').length > 0
  if (armed) return []
  return [{
    id: 'A2',
    severity: 'P1',
    dedupeKey: 'A2',
    title: 'Sale open window reached but ARM not loaded',
    body: `openTimestamp=${ctx.params.openTimestamp} has passed but no ArmLoaded event has been seen.`,
    runbook: 'OPERATIONS.md §3 Steps 4–5',
  }]
}

// A3 — Week-1 action outside week-1 window (P0)
export const ruleA3: AlertRule = (ctx) => {
  const out: AlertEvent[] = []
  for (const e of ctx.snapshot.events) {
    if (e.type !== 'SeedAdded' && e.type !== 'LaunchTeamInvited') continue
    // The graph keeps events ordered by block; we cannot trivially derive timestamp
    // from the event itself, but the indexer guarantees no event past the contract's
    // own week-1 guard. A week-1 violation would mean a contract or RPC failure.
    // Use blockNumber as the dedupe seed so each offending event fires once.
    if (e.blockNumber === 0) continue
    // Coarse-grained timestamp comparison would require block-timestamp lookups;
    // the contract's _requireArmLoadedAndPreInviteEnd already enforces this. If a
    // week-1 event ever appears past week1Deadline, the indexer + chain are
    // inconsistent — surface it.
    // For now, A3 is wired but only fires when an indexer extension supplies
    // event timestamps. Skip when timestamp is unknown.
    const timestamp = Number((e.args as { _timestamp?: number })._timestamp ?? 0)
    if (timestamp === 0) continue
    if (timestamp <= ctx.params.week1Deadline) continue
    out.push({
      id: 'A3',
      severity: 'P0',
      dedupeKey: `A3:${e.type}:${e.transactionHash}:${e.logIndex}`,
      title: 'Week-1 action emitted after week-1 deadline',
      body: `${e.type} emitted at block ${e.blockNumber} after week1Deadline. Investigate immediately.`,
      runbook: 'OPERATIONS.md §9 failure investigation',
    })
  }
  return out
}

// A4 — Seed budget thresholds (P2 → P1)
export const ruleA4: AlertRule = (ctx) => {
  const seedCount = eventsOfType(ctx.snapshot.events, 'SeedAdded').length
  const crossed = nearestCrossedTier(seedCount, CROWDFUND_CONSTANTS.MAX_SEEDS, TIER_LEVELS)
  if (crossed === null) return []
  return [{
    id: 'A4',
    severity: severityForBudget(crossed),
    dedupeKey: `A4:${crossed}`,
    title: `Seed budget at ${crossed}% (${seedCount}/${CROWDFUND_CONSTANTS.MAX_SEEDS})`,
    body: `Hop-0 SeedAdded count reached ${crossed}% of the configured MAX_SEEDS (${CROWDFUND_CONSTANTS.MAX_SEEDS}).`,
    runbook: 'OPERATIONS.md §4 Week-1 go/no-go; §10 decision log',
    context: { seedCount, crossedTier: crossed },
  }]
}

// A5 — Launch-team placement budget thresholds (P2 → P1)
export const ruleA5: AlertRule = (ctx) => {
  const hop1 = countLaunchTeamPlacementsAtHop(ctx.snapshot.events, 1)
  const hop2 = countLaunchTeamPlacementsAtHop(ctx.snapshot.events, 2)
  const out: AlertEvent[] = []

  const crossed1 = nearestCrossedTier(hop1, CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP1_BUDGET, TIER_LEVELS)
  if (crossed1 !== null) {
    out.push({
      id: 'A5',
      severity: severityForBudget(crossed1),
      dedupeKey: `A5:hop1:${crossed1}`,
      title: `Launch-team hop-1 placements at ${crossed1}%`,
      body: `Hop-1 placements: ${hop1}/${CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP1_BUDGET}.`,
      runbook: 'OPERATIONS.md §4 Week-1 operations; §10 decision log',
      context: { hop: 1, count: hop1, crossedTier: crossed1 },
    })
  }
  const crossed2 = nearestCrossedTier(hop2, CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP2_BUDGET, TIER_LEVELS)
  if (crossed2 !== null) {
    out.push({
      id: 'A5',
      severity: severityForBudget(crossed2),
      dedupeKey: `A5:hop2:${crossed2}`,
      title: `Launch-team hop-2 placements at ${crossed2}%`,
      body: `Hop-2 placements: ${hop2}/${CROWDFUND_CONSTANTS.LAUNCH_TEAM_HOP2_BUDGET}.`,
      runbook: 'OPERATIONS.md §4 Week-1 operations; §10 decision log',
      context: { hop: 2, count: hop2, crossedTier: crossed2 },
    })
  }
  return out
}

// A6 — Duplicate same-hop slot growth (P2, awareness only)
export const ruleA6: AlertRule = (ctx) => {
  const occupied = occupiedHop12Count(ctx.snapshot.graph)
  if (occupied === 0) return []
  const duplicates = duplicateSlotNodeCount(ctx.snapshot.graph)
  const ratio = duplicates / occupied
  if (ratio < ctx.thresholds.duplicateSlotFraction) return []
  // Bucket the ratio into 10-point bands so a fluctuating ratio fires once per band
  // rather than once per whole-percent (which produced up to ~100 distinct alerts).
  const bucket = Math.floor((ratio * 100) / 10) * 10
  return [{
    id: 'A6',
    severity: 'P2',
    dedupeKey: `A6:${bucket}`,
    title: `Duplicate same-hop slot ratio ${(ratio * 100).toFixed(1)}%`,
    body: `${duplicates}/${occupied} hop-1+hop-2 nodes have multiple slots. Intentional under the design; this is an awareness alert (see MONITORING.md §9.1).`,
    runbook: 'OPERATIONS.md §4/§5 monitoring; no automatic intervention',
    context: { duplicates, occupied, ratio },
  }]
}

// A7 — Expansion threshold approaching (P2)
export const ruleA7: AlertRule = (ctx) => {
  const capped = cappedDemandTotal(ctx.snapshot.graph)
  if (capped === 0n) return []
  const ratioPct = Number((capped * 100n) / CROWDFUND_CONSTANTS.ELASTIC_TRIGGER)
  let crossed: number | null = null
  for (const t of EXPANSION_TIERS) if (ratioPct >= t) crossed = t
  if (crossed === null) return []
  return [{
    id: 'A7',
    severity: 'P2',
    dedupeKey: `A7:${crossed}`,
    title: `cappedDemand at ${crossed}% of ELASTIC_TRIGGER`,
    body: `cappedDemand=${capped.toString()} (${ratioPct}% of ELASTIC_TRIGGER ${CROWDFUND_CONSTANTS.ELASTIC_TRIGGER.toString()}).`,
    runbook: 'OPERATIONS.md §5 pre-finalization checkpoint',
    context: { cappedDemand: capped.toString(), crossedTier: crossed },
  }]
}

// A8 — Minimum raise at risk late in sale (P2)
export const ruleA8: AlertRule = (ctx) => {
  if (!isSnapshotTrustworthy(ctx)) return []
  const capped = cappedDemandTotal(ctx.snapshot.graph)
  if (capped >= CROWDFUND_CONSTANTS.MIN_SALE) return []
  const remaining = ctx.params.commitmentDeadline - ctx.now
  if (remaining <= 0) return []
  const TWENTY_FOUR_H = 24 * 60 * 60
  const SEVENTY_TWO_H = 72 * 60 * 60
  let band: '72h' | '24h' | null = null
  if (remaining <= TWENTY_FOUR_H) band = '24h'
  else if (remaining <= SEVENTY_TWO_H) band = '72h'
  if (!band) return []
  return [{
    id: 'A8',
    severity: 'P2',
    dedupeKey: `A8:${band}`,
    title: `Minimum raise at risk with ${band} remaining`,
    body: `cappedDemand=${capped.toString()} below MIN_SALE=${CROWDFUND_CONSTANTS.MIN_SALE.toString()} with ${band} until commitmentDeadline.`,
    runbook: 'OPERATIONS.md §5 Weeks 2–3 cadence; §11 Checkpoint 3',
    context: { cappedDemand: capped.toString(), band },
  }]
}

// A9a — Deadline passed, qualified, finalization needed (P1 → P0 after grace)
export const ruleA9a: AlertRule = (ctx) => {
  if (!isSnapshotTrustworthy(ctx)) return []
  if (ctx.now <= ctx.params.commitmentDeadline) return []
  const finalized = eventsOfType(ctx.snapshot.events, 'Finalized').length > 0
  const cancelled = eventsOfType(ctx.snapshot.events, 'Cancelled').length > 0
  if (finalized || cancelled) return []
  const capped = cappedDemandTotal(ctx.snapshot.graph)
  if (capped < CROWDFUND_CONSTANTS.MIN_SALE) return []
  const past = ctx.now - ctx.params.commitmentDeadline
  const severity: 'P1' | 'P0' = past >= ctx.thresholds.finalizeGraceSeconds ? 'P0' : 'P1'
  return [{
    id: 'A9a',
    severity,
    dedupeKey: `A9a:${severity}`,
    title: `Deadline passed; finalize() required`,
    body: `commitmentDeadline ${past}s ago; cappedDemand=${capped.toString()} ≥ MIN_SALE. Call finalize().`,
    runbook: 'OPERATIONS.md §11 Checkpoint 3; §6 Finalization procedure',
    context: { cappedDemand: capped.toString(), past, severity },
  }]
}

// A9b — Deadline passed, sub-minimum demand (P1)
export const ruleA9b: AlertRule = (ctx) => {
  if (!isSnapshotTrustworthy(ctx)) return []
  if (ctx.now <= ctx.params.commitmentDeadline) return []
  const finalized = eventsOfType(ctx.snapshot.events, 'Finalized').length > 0
  const cancelled = eventsOfType(ctx.snapshot.events, 'Cancelled').length > 0
  if (finalized || cancelled) return []
  const capped = cappedDemandTotal(ctx.snapshot.graph)
  if (capped >= CROWDFUND_CONSTANTS.MIN_SALE) return []
  return [{
    id: 'A9b',
    severity: 'P1',
    dedupeKey: 'A9b',
    title: 'Deadline passed; sub-minimum demand',
    body: `cappedDemand=${capped.toString()} below MIN_SALE. Permissionless finalize() will activate refundMode.`,
    runbook: 'OPERATIONS.md §5 pre-finalization checkpoint (sub-minimum branch)',
    context: { cappedDemand: capped.toString() },
  }]
}

// A10 — RefundMode triggered (P1)
export const ruleA10: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f) return []
  if (f.args.refundMode !== true) return []
  return [{
    id: 'A10',
    severity: 'P1',
    dedupeKey: 'A10',
    title: 'refundMode triggered at finalization',
    body: `Finalized(refundMode=true) at block ${f.blockNumber}. Participants can claim full refunds. Not an exploit (see MONITORING.md §9.2).`,
    runbook: 'OPERATIONS.md §6 Path C (refundMode); §9.7',
  }]
}

// A11 — Cancel triggered (P0)
export const ruleA11: AlertRule = (ctx) => {
  const c = findLatestEvent(ctx.snapshot.events, 'Cancelled')
  if (!c) return []
  return [{
    id: 'A11',
    severity: 'P0',
    dedupeKey: 'A11',
    title: 'Crowdfund cancelled',
    body: `Cancelled emitted at block ${c.blockNumber}. Security Council action.`,
    runbook: 'OPERATIONS.md §7 cancel procedure',
  }]
}

// A12 — Successful finalization (P3)
export const ruleA12: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f) return []
  if (f.args.refundMode === true) return []
  return [{
    id: 'A12',
    severity: 'P3',
    dedupeKey: 'A12',
    title: 'Crowdfund finalized successfully',
    body: `Finalized(refundMode=false) at block ${f.blockNumber}. saleSize=${String(f.args.saleSize)}, netProceeds=${String(f.args.netProceeds)}.`,
    runbook: 'OPERATIONS.md §6 post-finalization verification; §8',
  }]
}

// A13 — Treasury proceeds mismatch (P0)
//
// The contract reduces the proceeds transfer by a rounding buffer equal to
// participantNodes.length (NOT × NUM_HOPS as the spec text claims — see contract
// line 511). Treasury balance increase must equal netProceeds within that
// buffer; anything more is a real mismatch.
//
// LIMITATION: ctx.treasuryUsdcBalance is the treasury's CURRENT balance, not its balance
// at the finalization block. A pre-existing balance, or any treasury inflow/outflow after
// finalization, will skew the comparison and can produce a false positive. Properly fixing
// this needs a balance-at-finalization-block read; until then the alert body tells the
// responder to verify against the finalization-block balance before escalating.
export const ruleA13: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f) return []
  if (f.args.refundMode === true) return []
  if (ctx.treasuryUsdcBalance === null) return []
  const netProceeds = BigInt(String(f.args.netProceeds))
  const participantNodes = BigInt(ctx.snapshot.graph.nodes.size)
  const diff = netProceeds > ctx.treasuryUsdcBalance
    ? netProceeds - ctx.treasuryUsdcBalance
    : ctx.treasuryUsdcBalance - netProceeds
  if (diff <= participantNodes) return []
  return [{
    id: 'A13',
    severity: 'P0',
    dedupeKey: 'A13',
    title: 'Treasury proceeds mismatch',
    body: `Treasury USDC balance=${ctx.treasuryUsdcBalance.toString()} vs Finalized.netProceeds=${netProceeds.toString()}; diff=${diff.toString()} exceeds rounding buffer ${participantNodes.toString()}. NOTE: this compares the treasury's CURRENT balance, not its balance at the finalization block — a pre-existing balance or later treasury movement can cause a false positive. Verify against the finalization-block balance before escalating.`,
    runbook: 'OPERATIONS.md §8 proceeds verification',
    context: {
      treasuryUsdcBalance: ctx.treasuryUsdcBalance.toString(),
      netProceeds: netProceeds.toString(),
      diff: diff.toString(),
      roundingBuffer: participantNodes.toString(),
    },
  }]
}

// A17 — Unexpected settlement events after refundMode or cancel (P0)
export const ruleA17: AlertRule = (ctx) => {
  const finalized = findLatestEvent(ctx.snapshot.events, 'Finalized')
  const cancelled = findLatestEvent(ctx.snapshot.events, 'Cancelled')
  const refundModeBlock = finalized && finalized.args.refundMode === true ? finalized.blockNumber : null
  const cancelledBlock = cancelled ? cancelled.blockNumber : null
  const watermarks = [refundModeBlock, cancelledBlock].filter((b): b is number => typeof b === 'number')
  if (watermarks.length === 0) return []
  const earliest = Math.min(...watermarks)
  const offenders = ctx.snapshot.events.filter(
    (e) => (e.type === 'Allocated' || e.type === 'AllocatedHop') && e.blockNumber >= earliest,
  )
  if (offenders.length === 0) return []
  return offenders.map((e) => ({
    id: 'A17' as const,
    severity: 'P0' as const,
    dedupeKey: `A17:${e.transactionHash}:${e.logIndex}`,
    title: 'Settlement event after refundMode/cancel',
    body: `${e.type} emitted at block ${e.blockNumber} after refundMode/cancel watermark (block ${earliest}). Must not occur.`,
    runbook: 'Immediate investigation — implementation bug',
  }))
}

// A18 — ARM claims participation lag (P2)
export const ruleA18: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f || f.args.refundMode === true) return []
  if (ctx.finalizedAt === null) return []
  const fourteenDays = 14 * 24 * 60 * 60
  if (ctx.now - ctx.finalizedAt < fourteenDays) return []
  const expected = uniqueCommittedAddressCount(ctx.snapshot.events)
  if (expected === 0) return []
  const claimed = eventsOfType(ctx.snapshot.events, 'Allocated').length
  const ratio = claimed / expected
  if (ratio >= ctx.thresholds.claimParticipationFloor) return []
  return [{
    id: 'A18',
    severity: 'P2',
    dedupeKey: 'A18',
    title: `ARM claim participation below ${Math.round(ctx.thresholds.claimParticipationFloor * 100)}%`,
    body: `${claimed}/${expected} (${(ratio * 100).toFixed(1)}%) participants have claimed ARM 14d+ after finalization.`,
    runbook: 'OPERATIONS.md §8 claims monitoring',
    context: { claimed, expected, ratio },
  }]
}

// A19 — Refund participation lag (P2)
export const ruleA19: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f) return []
  if (ctx.finalizedAt === null) return []
  const thirtyDays = 30 * 24 * 60 * 60
  if (ctx.now - ctx.finalizedAt < thirtyDays) return []
  let refundable = 0n
  for (const s of ctx.snapshot.graph.summaries.values()) {
    if (s.refundUsdc !== null) refundable += s.refundUsdc
  }
  if (refundable === 0n) return []
  let claimed = 0n
  for (const e of ctx.snapshot.events) {
    if (e.type === 'RefundClaimed') claimed += BigInt(String(e.args.usdcAmount))
  }
  const unclaimed = refundable > claimed ? refundable - claimed : 0n
  if (unclaimed === 0n) return []
  const unclaimedFraction = Number((unclaimed * 10_000n) / refundable) / 10_000
  if (unclaimedFraction < ctx.thresholds.refundUnclaimedThreshold) return []
  return [{
    id: 'A19',
    severity: 'P2',
    dedupeKey: 'A19',
    title: `Refund unclaimed > ${Math.round(ctx.thresholds.refundUnclaimedThreshold * 100)}%`,
    body: `${unclaimed.toString()} USDC unclaimed of ${refundable.toString()} total refundable 30d+ after finalization.`,
    runbook: 'OPERATIONS.md §8 claims monitoring',
    context: {
      unclaimed: unclaimed.toString(),
      refundable: refundable.toString(),
      unclaimedFraction,
    },
  }]
}

// A20 — 3-year sweep window reached (P2)
export const ruleA20: AlertRule = (ctx) => {
  const f = findLatestEvent(ctx.snapshot.events, 'Finalized')
  if (!f || f.args.refundMode === true) return []
  if (ctx.finalizedAt === null) return []
  if (ctx.now <= ctx.finalizedAt + CROWDFUND_CONSTANTS.CLAIM_DEADLINE_DURATION) return []
  return [{
    id: 'A20',
    severity: 'P2',
    dedupeKey: 'A20',
    title: '3-year sweep window reached',
    body: 'Unclaimed ARM is now sweepable via withdrawUnallocatedArm().',
    runbook: 'OPERATIONS.md §8 3-year deadline sweep',
  }]
}

// AH1 — Indexer health degraded (unhealthy → P1, stale → P2)
//
// Fires when the indexer can no longer be trusted to reflect chain state. The dedupe
// key is bucketed by UTC day so a sustained outage re-pages once per day; a single
// cron tick never double-fires.
export const ruleAH1: AlertRule = (ctx) => {
  const status = ctx.health.status
  if (status !== 'unhealthy' && status !== 'stale') return []
  const severity: 'P1' | 'P2' = status === 'unhealthy' ? 'P1' : 'P2'
  return [{
    id: 'AH1',
    severity,
    dedupeKey: `AH1:${status}:${utcDateBucket(ctx.now)}`,
    title: `Indexer health ${status}`,
    body: `Indexer status is ${status} (verifiedCursor=${ctx.health.verifiedCursor}, lagBlocks=${ctx.health.lagBlocks}, lastError=${ctx.health.lastError ?? 'none'}). Frontends are serving the last verified snapshot; time-based alerts are suppressed until it recovers.`,
    runbook: 'CROWDFUND_INDEXER_RUNBOOK.md health triage',
    context: { status, lagBlocks: ctx.health.lagBlocks, verifiedCursor: ctx.health.verifiedCursor },
  }]
}

// AH2 — Indexer gaps require operator intervention (P0/manual) — P1
//
// Fires when auto-repair has exhausted its attempt limit on one or more ranges. The
// dedupe key includes the formatted range list so a newly-exhausted gap re-pages.
export const ruleAH2: AlertRule = (ctx) => {
  const gaps = ctx.health.gapsRequiringIntervention
  if (!gaps || gaps.length === 0) return []
  const ranges = gaps.map((g) => `${g.fromBlock}-${g.toBlock}`).join(',')
  return [{
    id: 'AH2',
    severity: 'P1',
    dedupeKey: `AH2:${ranges}`,
    title: 'Indexer gaps require operator intervention',
    body: `${gaps.length} block range(s) have exhausted auto-repair and need manual repair: ${ranges}. Run: npm run crowdfund:indexer:cli -- repair`,
    runbook: 'CROWDFUND_INDEXER_RUNBOOK.md gap repair',
    context: { ranges, count: gaps.length },
  }]
}

export const ALL_RULES: ReadonlyArray<{ id: string; rule: AlertRule }> = [
  { id: 'A1', rule: ruleA1 },
  { id: 'A2', rule: ruleA2 },
  { id: 'A3', rule: ruleA3 },
  { id: 'A4', rule: ruleA4 },
  { id: 'A5', rule: ruleA5 },
  { id: 'A6', rule: ruleA6 },
  { id: 'A7', rule: ruleA7 },
  { id: 'A8', rule: ruleA8 },
  { id: 'A9a', rule: ruleA9a },
  { id: 'A9b', rule: ruleA9b },
  { id: 'A10', rule: ruleA10 },
  { id: 'A11', rule: ruleA11 },
  { id: 'A12', rule: ruleA12 },
  { id: 'A13', rule: ruleA13 },
  { id: 'A17', rule: ruleA17 },
  { id: 'A18', rule: ruleA18 },
  { id: 'A19', rule: ruleA19 },
  { id: 'A20', rule: ruleA20 },
  { id: 'AH1', rule: ruleAH1 },
  { id: 'AH2', rule: ruleAH2 },
]

export function evaluateAllRules(ctx: AlertContext): AlertEvent[] {
  const out: AlertEvent[] = []
  for (const { rule } of ALL_RULES) out.push(...rule(ctx))
  return out
}
