// ABOUTME: TypeScript types mirroring the ArmadaCrowdfund Solidity structs and enums.
// ABOUTME: Used throughout the frontend to type contract return values.

export const Phase = {
  Setup: 0,
  Invitation: 1,
  Commitment: 2,
  Finalized: 3,
  Canceled: 4,
} as const

export type Phase = (typeof Phase)[keyof typeof Phase]

export interface Participant {
  hop: number
  isWhitelisted: boolean
  committed: bigint
  allocation: bigint
  refund: bigint
  claimed: boolean
  invitedBy: string
  invitesSent: number
}

export interface HopStats {
  totalCommitted: bigint
  uniqueCommitters: number
  whitelistCount: number
}

export interface AllocationInfo {
  allocation: bigint
  refund: bigint
  claimed: boolean
}

export interface CrowdfundDeployment {
  chainId: number
  deployer: string
  contracts: {
    armToken: string
    usdc: string
    crowdfund: string
  }
  config: {
    baseSale: string
    maxSale: string
    minSale: string
    armPrice: string
    armFunded: string
  }
  timestamp: string
}

export interface CrowdfundEvent {
  name: string
  args: Record<string, unknown>
  blockNumber: number
  transactionHash: string
}

/** Contract constants matching ArmadaCrowdfund.sol */
export const CROWDFUND_CONSTANTS = {
  BASE_SALE: 1_200_000n * 1_000_000n,
  MAX_SALE: 1_800_000n * 1_000_000n,
  MIN_SALE: 1_000_000n * 1_000_000n,
  ARM_PRICE: 1_000_000n,
  INVITATION_DURATION: 14 * 86400,
  COMMITMENT_DURATION: 7 * 86400,
  HOP_CAPS: [15_000n * 1_000_000n, 4_000n * 1_000_000n, 1_000n * 1_000_000n] as const,
  HOP_RESERVE_BPS: [7000, 2500, 500] as const,
  HOP_MAX_INVITES: [3, 2, 0] as const,
  HOP1_ROLLOVER_MIN: 30,
  HOP2_ROLLOVER_MIN: 50,
  NUM_HOPS: 3,
} as const
