// ABOUTME: Pure parsing functions for ArmadaCrowdfund contract struct return values.
// ABOUTME: Extracted from useCrowdfund hook for testability.
import type { Participant, HopStats } from '@/types/crowdfund'

/** Parse contract's Participant struct return value (array of positional fields) */
export function parseParticipant(result: any): Participant {
  return {
    isWhitelisted: result[0] as boolean,
    invitesReceived: Number(result[1]),
    committed: BigInt(result[2]),
    allocation: BigInt(result[3]),
    refund: BigInt(result[4]),
    claimed: result[5] as boolean,
    invitedBy: result[6] as string,
    invitesSent: Number(result[7]),
  }
}

/** Parse contract's HopStats struct return value (array of positional fields) */
export function parseHopStats(result: any): HopStats {
  return {
    totalCommitted: BigInt(result[0]),
    uniqueCommitters: Number(result[1]),
    whitelistCount: Number(result[2]),
  }
}
