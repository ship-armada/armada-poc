// ABOUTME: Pure helpers for the committer's claim-page gate and pre-finalize refund projection.
// ABOUTME: Projects refund mode from the post-waterfall allocation, mirroring ArmadaCrowdfund.finalize().

import { CROWDFUND_CONSTANTS, estimateAllocation } from '@armada/crowdfund-shared'

export type ClaimAvailability =
  | { state: 'available' }
  | { state: 'pending'; reason: string }
  | { state: 'pre-open' }

/**
 * Whether finalize() will enter refund mode, projected before it is called.
 * Once the commit window closes, capped demand is frozen, so the outcome is
 * deterministic: finalize() refunds when the post-waterfall allocation falls
 * below MIN_SALE. Capped demand alone is not enough — demand concentrated in
 * hop-0 can clear MIN_SALE yet allocate below it. Only meaningful pre-finalize
 * (phase 0); afterwards the contract's `refundMode` flag is authoritative.
 */
export function isProjectedRefund(state: {
  phase: number
  windowEnd: number
  blockTimestamp: number
  hopStats: readonly { cappedCommitted: bigint }[]
  cappedDemand: bigint
}): boolean {
  if (state.phase !== 0) return false
  const windowEnded = state.windowEnd > 0 && state.blockTimestamp > state.windowEnd
  if (!windowEnded) return false
  const { totalAllocUsdc } = estimateAllocation(state.hopStats, state.cappedDemand, 0n)
  return totalAllocUsdc < CROWDFUND_CONSTANTS.MIN_SALE
}

/** Mirror of the Claim page's gate. Used both to gate tab presentation
 *  ("(soon)" suffix) and to drive the Claim page's empty-state copy. */
export function getClaimAvailability(
  phase: number,
  armLoaded: boolean,
  windowEnd: number,
  blockTimestamp: number,
  projectedRefund: boolean,
): ClaimAvailability {
  if (!armLoaded && phase === 0) return { state: 'pre-open' }
  if (phase === 1) return { state: 'available' } // finalized
  if (phase === 2) return { state: 'available' } // cancelled (refunds)

  // phase 0
  const windowEnded = windowEnd > 0 && blockTimestamp > windowEnd
  if (windowEnded && projectedRefund) return { state: 'available' } // refund eligibility
  if (windowEnded) return { state: 'pending', reason: 'Awaiting finalization' }
  return { state: 'pending', reason: 'Opens after the campaign window ends' }
}
