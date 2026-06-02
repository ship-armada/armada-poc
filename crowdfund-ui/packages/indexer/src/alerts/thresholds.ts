// ABOUTME: Threshold defaults from MONITORING.md §13, with environment-variable overrides.
// ABOUTME: Pure helpers — no side effects beyond reading process.env.

import type { AlertThresholds } from './types.js'

const DEFAULTS: AlertThresholds = {
  duplicateSlotFraction: 0.10,
  finalizeGraceSeconds: 2 * 60 * 60,
  claimParticipationFloor: 0.50,
  refundUnclaimedThreshold: 0.10,
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${name}`)
  }
  return parsed
}

export function readThresholdsFromEnv(): AlertThresholds {
  return {
    duplicateSlotFraction: readNumber(
      'CROWDFUND_ALERT_DUPLICATE_SLOT_FRACTION',
      DEFAULTS.duplicateSlotFraction,
    ),
    finalizeGraceSeconds: readNumber(
      'CROWDFUND_ALERT_FINALIZE_GRACE_SECONDS',
      DEFAULTS.finalizeGraceSeconds,
    ),
    claimParticipationFloor: readNumber(
      'CROWDFUND_ALERT_CLAIM_PARTICIPATION_FLOOR',
      DEFAULTS.claimParticipationFloor,
    ),
    refundUnclaimedThreshold: readNumber(
      'CROWDFUND_ALERT_REFUND_UNCLAIMED_THRESHOLD',
      DEFAULTS.refundUnclaimedThreshold,
    ),
  }
}

export const ALERT_THRESHOLD_DEFAULTS = DEFAULTS
