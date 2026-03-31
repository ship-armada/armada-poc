// ABOUTME: Crowdfund contract constants, hop configuration, and ABI fragments.
// ABOUTME: Single source of truth for all magic numbers referenced across the UI apps.

/** Sale size parameters (USDC, 6 decimals) */
export const CROWDFUND_CONSTANTS = {
  BASE_SALE: 1_200_000n * 10n ** 6n,
  MAX_SALE: 1_800_000n * 10n ** 6n,
  MIN_SALE: 1_000_000n * 10n ** 6n,
  ELASTIC_TRIGGER: 1_500_000n * 10n ** 6n,
  ARM_PRICE: 1_000_000n, // 1 USDC per ARM (6-decimal USDC = 1e6)
  MAX_SEEDS: 150,
  LAUNCH_TEAM_HOP1_BUDGET: 60,
  LAUNCH_TEAM_HOP2_BUDGET: 60,
  MIN_COMMIT: 10n * 10n ** 6n,
  WINDOW_DURATION: 21 * 24 * 60 * 60, // 21 days in seconds
  LAUNCH_TEAM_INVITE_PERIOD: 7 * 24 * 60 * 60, // 7 days in seconds
  CLAIM_DEADLINE_DURATION: 1095 * 24 * 60 * 60, // 3 years in seconds
  GOVERNANCE_QUIET_PERIOD: 7 * 24 * 60 * 60, // 7 days in seconds (matches ArmadaGovernor.QUIET_PERIOD_DURATION)
  HOP2_FLOOR_BPS: 500, // 5%
} as const

/** Per-hop configuration matching the contract's hopConfigs[3] */
export interface HopConfig {
  readonly ceilingBps: number
  readonly capUsdc: bigint
  readonly maxInvites: number
  readonly maxInvitesReceived: number
}

export const HOP_CONFIGS: readonly [HopConfig, HopConfig, HopConfig] = [
  { ceilingBps: 7000, capUsdc: 15_000n * 10n ** 6n, maxInvites: 3, maxInvitesReceived: 1 },
  { ceilingBps: 4500, capUsdc: 4_000n * 10n ** 6n, maxInvites: 2, maxInvitesReceived: 10 },
  { ceilingBps: 0, capUsdc: 1_000n * 10n ** 6n, maxInvites: 0, maxInvitesReceived: 20 },
] as const

/** ABI fragments for event parsing and contract reads */
export const CROWDFUND_ABI_FRAGMENTS = [
  'event ArmLoaded()',
  'event SeedAdded(address indexed seed)',
  'event Invited(address indexed inviter, address indexed invitee, uint8 hop, uint256 nonce)',
  'event Committed(address indexed participant, uint8 hop, uint256 amount)',
  'event Finalized(uint256 saleSize, uint256 allocatedArm, uint256 netProceeds, bool refundMode)',
  'event Cancelled()',
  'event Allocated(address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate)',
  'event AllocatedHop(address indexed participant, uint8 indexed hop, uint256 acceptedUsdc)',
  'event RefundClaimed(address indexed participant, uint256 usdcAmount)',
  'event InviteNonceRevoked(address indexed inviter, uint256 nonce)',
  'event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount)',
  'function phase() view returns (uint8)',
  'function armLoaded() view returns (bool)',
  'function totalCommitted() view returns (uint256)',
  'function cappedDemand() view returns (uint256)',
  'function saleSize() view returns (uint256)',
  'function windowStart() view returns (uint256)',
  'function windowEnd() view returns (uint256)',
  'function launchTeamInviteEnd() view returns (uint256)',
  'function finalizedAt() view returns (uint256)',
  'function claimDeadline() view returns (uint256)',
  'function refundMode() view returns (bool)',
  'function totalAllocatedArm() view returns (uint256)',
  'function totalArmTransferred() view returns (uint256)',
  'function launchTeam() view returns (address)',
  'function securityCouncil() view returns (address)',
  'function treasury() view returns (address)',
  'function getHopStats(uint8 hop) view returns (uint256 totalCommitted, uint256 cappedCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function getLaunchTeamBudgetRemaining() view returns (uint256 hop1Remaining, uint256 hop2Remaining)',
  'function getParticipantCount() view returns (uint256)',
  'function computeAllocation(address addr) view returns (uint256 armAmount, uint256 refundUsdc)',
  'function computeAllocationAtHop(address addr, uint8 hop) view returns (uint256 armAmount, uint256 refundUsdc)',
  'function claimed(address) view returns (bool)',
  'function getEffectiveCap(address addr, uint8 hop) view returns (uint256)',
  'function getInvitesRemaining(address addr, uint8 hop) view returns (uint16)',
  'function usedNonces(address inviter, uint256 nonce) view returns (bool)',
  // Write functions (used by committer and admin)
  'function commit(uint8 hop, uint256 amount) external',
  'function invite(address invitee, uint8 inviterHop) external',
  'function commitWithInvite(address inviter, uint8 fromHop, uint256 nonce, uint256 deadline, bytes signature, uint256 amount) external',
  'function revokeInviteNonce(uint256 nonce) external',
  'function claim(address delegate) external',
  'function claimRefund() external',
  'function addSeeds(address[] seeds) external',
  'function addSeed(address seed) external',
  'function loadArm() external',
  'function finalize() external',
  'function cancel() external',
  'function withdrawUnallocatedArm() external',
  'function launchTeamInvite(address invitee, uint8 fromHop) external',
] as const

/** ERC-20 ABI fragments for USDC approval and balance checks */
export const ERC20_ABI_FRAGMENTS = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
] as const
