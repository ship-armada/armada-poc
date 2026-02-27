// ABOUTME: Jotai atoms for crowdfund contract state (phase, stats, participants).
// ABOUTME: Updated by the useCrowdfund hook; consumed by UI components.
import { atom } from 'jotai'
import type { Phase, HopStats, Participant, CrowdfundEvent, CrowdfundDeployment } from '@/types/crowdfund'

export interface CrowdfundState {
  // Contract phase and timing
  phase: Phase | null
  adminAddress: string | null
  invitationStart: bigint
  invitationEnd: bigint
  commitmentStart: bigint
  commitmentEnd: bigint
  // Aggregate stats
  totalCommitted: bigint
  saleSize: bigint
  hopStats: [HopStats, HopStats, HopStats] | null
  participantCount: number
  // Current user's data
  currentParticipant: Participant | null
  currentInvitesRemaining: number
  currentAllocation: { allocation: bigint; refund: bigint; claimed: boolean } | null
  // Balances
  usdcBalance: bigint
  armBalance: bigint
  usdcAllowance: bigint
  // Chain time (use instead of Date.now() — EVM time diverges from wall clock in local mode)
  blockTimestamp: number
  // App state
  isLoading: boolean
  lastUpdated: number | null
  error: string | null
}

const DEFAULT_STATE: CrowdfundState = {
  phase: null,
  adminAddress: null,
  invitationStart: 0n,
  invitationEnd: 0n,
  commitmentStart: 0n,
  commitmentEnd: 0n,
  totalCommitted: 0n,
  saleSize: 0n,
  hopStats: null,
  participantCount: 0,
  currentParticipant: null,
  currentInvitesRemaining: 0,
  currentAllocation: null,
  usdcBalance: 0n,
  armBalance: 0n,
  usdcAllowance: 0n,
  blockTimestamp: 0,
  isLoading: true,
  lastUpdated: null,
  error: null,
}

export const crowdfundStateAtom = atom<CrowdfundState>(DEFAULT_STATE)

/** Event log (newest first) */
export const eventLogAtom = atom<CrowdfundEvent[]>([])

/** Loaded deployment data */
export const deploymentAtom = atom<CrowdfundDeployment | null>(null)

/** Participant list for the table (fetched separately since it's expensive) */
export interface ParticipantRow {
  address: string
  participant: Participant
}
export const participantListAtom = atom<ParticipantRow[]>([])
export const participantListLoadingAtom = atom<boolean>(false)
