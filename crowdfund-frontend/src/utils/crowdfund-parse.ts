// ABOUTME: Pure parsing functions for ArmadaCrowdfund contract struct return values.
// ABOUTME: Extracted from useCrowdfund hook for testability.
import type { Participant, HopStats } from '@/types/crowdfund'

/** Parse contract's Participant struct return value (array of positional fields) */
export function parseParticipant(result: any): Participant {
  return {
    isWhitelisted: result[0] as boolean,
    invitesReceived: Number(result[1]),
    committed: BigInt(result[2]),
    invitedBy: result[3] as string,
    invitesSent: Number(result[4]),
    // Computed fields default to zero — populated later from computeAllocation
    allocation: 0n,
    refund: 0n,
    claimed: false,
  }
}

/** Parse contract's HopStats struct return value (array of positional fields) */
export function parseHopStats(result: any): HopStats {
  return {
    totalCommitted: BigInt(result[0]),
    cappedCommitted: BigInt(result[1]),
    uniqueCommitters: Number(result[2]),
    whitelistCount: Number(result[3]),
  }
}
