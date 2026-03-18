// ABOUTME: TypeScript types mirroring the ArmadaCrowdfund Solidity structs and enums.
// ABOUTME: Used throughout the frontend to type contract return values.

export const Phase = {
  Setup: 0,
  Active: 1,
  Finalized: 2,
  Canceled: 3,
} as const

export type Phase = (typeof Phase)[keyof typeof Phase]

export interface Participant {
  isWhitelisted: boolean
  invitesReceived: number
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
    treasury?: string
    governor?: string
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
  WINDOW_DURATION: 21 * 86400,
  LAUNCH_TEAM_INVITE_PERIOD: 7 * 86400,
  HOP_CAPS: [15_000n * 1_000_000n, 4_000n * 1_000_000n, 1_000n * 1_000_000n] as const,
  HOP_CEILING_BPS: [7000, 4500, 0] as const,
  HOP_MAX_INVITES: [3, 2, 0] as const,
  NUM_HOPS: 3,
} as const
