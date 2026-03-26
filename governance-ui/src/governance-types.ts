// ABOUTME: TypeScript types and enums for the Armada governance system.
// ABOUTME: Mirrors the on-chain data structures from the governance contracts.

/** Matches ArmadaGovernor.ProposalState enum */
export enum ProposalState {
  Pending = 0,
  Active = 1,
  Defeated = 2,
  Succeeded = 3,
  Queued = 4,
  Executed = 5,
  Canceled = 6,
}

/** Matches IArmadaGovernance.ProposalType enum */
export enum ProposalType {
  Standard = 0,
  Extended = 1,
  VetoRatification = 2,
}

/** Vote support values: 0=Against, 1=For, 2=Abstain */
export enum VoteSupport {
  Against = 0,
  For = 1,
  Abstain = 2,
}

/** Proposal data assembled from getProposal() + state() + event description */
export interface ProposalData {
  id: number
  proposer: string
  proposalType: ProposalType
  state: ProposalState
  voteStart: bigint
  voteEnd: bigint
  forVotes: bigint
  againstVotes: bigint
  abstainVotes: bigint
  snapshotBlock: bigint
  quorumRequired: bigint
  description: string
  // Whether the connected user has already voted
  hasVoted: boolean
  userVoteChoice: number | null
}

/** Steward action data from TreasurySteward.getAction() */
export interface StewardActionData {
  id: number
  target: string
  value: bigint
  timestamp: bigint
  executed: boolean
  vetoed: boolean
  executeAfter: bigint
}

/** Labels for proposal types */
export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  [ProposalType.Standard]: 'Standard',
  [ProposalType.Extended]: 'Extended',
  [ProposalType.VetoRatification]: 'Veto Ratification',
}

/** Labels for proposal states */
export const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  [ProposalState.Pending]: 'Pending',
  [ProposalState.Active]: 'Active',
  [ProposalState.Defeated]: 'Defeated',
  [ProposalState.Succeeded]: 'Succeeded',
  [ProposalState.Queued]: 'Queued',
  [ProposalState.Executed]: 'Executed',
  [ProposalState.Canceled]: 'Canceled',
}

/** Color classes for proposal state badges */
export const PROPOSAL_STATE_COLORS: Record<ProposalState, string> = {
  [ProposalState.Pending]: 'bg-yellow-900 text-yellow-300',
  [ProposalState.Active]: 'bg-blue-900 text-blue-300',
  [ProposalState.Defeated]: 'bg-red-900 text-red-300',
  [ProposalState.Succeeded]: 'bg-green-900 text-green-300',
  [ProposalState.Queued]: 'bg-purple-900 text-purple-300',
  [ProposalState.Executed]: 'bg-emerald-900 text-emerald-300',
  [ProposalState.Canceled]: 'bg-neutral-800 text-neutral-400',
}

/** Labels for vote support */
export const VOTE_SUPPORT_LABELS: Record<VoteSupport, string> = {
  [VoteSupport.Against]: 'Against',
  [VoteSupport.For]: 'For',
  [VoteSupport.Abstain]: 'Abstain',
}
