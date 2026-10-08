// ABOUTME: Claim-page gate and pre-finalize refund projection for the committer.
// ABOUTME: Refund is projected from post-waterfall allocation, matching ArmadaCrowdfund.finalize().

import { projectsRefundMode, type HopAllocationStats } from '@armada/crowdfund-shared'

export type ClaimAvailability =
  | { state: 'available' }
  | { state: 'pending'; reason: string }
  | { state: 'pre-open' }

/** Whether the closed-but-unfinalized sale will enter refund mode once someone
 *  calls finalize(). Capped demand is frozen once the window closes, so the
 *  outcome is already determined; it is projected from the post-waterfall
 *  allocation (see {@link projectsRefundMode}). False while the window is open
 *  and once the sale is finalized or cancelled — the contract's own state is
 *  authoritative then. */
export function isProjectedRefund(state: {
  phase: number
  windowEnd: number
  blockTimestamp: number
  hopStats: readonly HopAllocationStats[]
  cappedDemand: bigint
}): boolean {
  if (state.phase !== 0) return false
  const windowEnded = state.windowEnd > 0 && state.blockTimestamp > state.windowEnd
  if (!windowEnded) return false
  return projectsRefundMode(state.hopStats, state.cappedDemand)
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
