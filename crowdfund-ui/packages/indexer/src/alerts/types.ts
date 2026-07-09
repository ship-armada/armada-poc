// ABOUTME: Type definitions for the crowdfund alert evaluator.
// ABOUTME: Mirrors MONITORING.md alert ids, severity classes, and rule input shape.

import type { CrowdfundSnapshot, IndexerHealth } from '../types.js'

/**
 * Alert identifier matching MONITORING.md §8 (A1–A20). AH1/AH2 are indexer-health
 * alerts added by the hardening work (MONITORING.md §8 addendum).
 */
export type AlertId =
  | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8'
  | 'A9a' | 'A9b' | 'A10' | 'A11' | 'A12' | 'A13' | 'A17' | 'A18' | 'A19' | 'A20'
  | 'AH1' | 'AH2'

/** Severity class per MONITORING.md §4. */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3'

/**
 * A single alert occurrence. `dedupeKey` distinguishes repeatable threshold tiers
 * within the same alert id — e.g. A4 fires once at 80%, again at 90%, again at
 * 100%; each uses a different dedupeKey so the evaluator does not re-fire a tier
 * it has already announced.
 */
export interface AlertEvent {
  id: AlertId
  severity: Severity
  /** Stable string identifying this specific firing. e.g. "A4:80". */
  dedupeKey: string
  title: string
  /** Human-readable details for the delivery channel. */
  body: string
  /** Reference into OPERATIONS.md (or another runbook). */
  runbook: string
  /** Optional structured payload for downstream consumers. */
  context?: Record<string, string | number | boolean>
}

/** Parameters from the crowdfund deploy (timing + addresses). */
export interface CrowdfundParams {
  chainId: number
  contractAddress: string
  treasuryAddress: string
  /** Unix seconds; matches contract windowStart. */
  openTimestamp: number
  /** Unix seconds; openTimestamp + 7 days. */
  week1Deadline: number
  /** Unix seconds; openTimestamp + 21 days. */
  commitmentDeadline: number
}

/** Numeric thresholds — see MONITORING.md §13. Overridable per env var. */
export interface AlertThresholds {
  /** A6 — duplicate-slot watch threshold as a fraction of occupied hop-1/2 nodes (default 0.10). */
  duplicateSlotFraction: number
  /** A9a — grace window in seconds after commitmentDeadline before P1 escalates to P0. */
  finalizeGraceSeconds: number
  /** A18 — fraction of allocated participants whose claim is considered "expected" within 14 days. */
  claimParticipationFloor: number
  /** A19 — fraction of refundable USDC considered "unclaimed-lag" after 30 days. */
  refundUnclaimedThreshold: number
}

/** Inputs a rule may consult. Constructed once per evaluator tick. */
export interface AlertContext {
  /** Current unix seconds (test seam — default Date.now()/1000). */
  now: number
  params: CrowdfundParams
  snapshot: CrowdfundSnapshot
  health: IndexerHealth
  thresholds: AlertThresholds
  /** Treasury USDC balance (read at evaluator startup; null when unavailable). */
  treasuryUsdcBalance: bigint | null
  /** Unix seconds when finalize() was called; null pre-finalization or when unread. */
  finalizedAt: number | null
}

/** Pure rule signature — returns 0..n alert events given current context. */
export type AlertRule = (ctx: AlertContext) => AlertEvent[]
