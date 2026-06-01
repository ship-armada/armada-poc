// ABOUTME: Crowdfund contract constants, hop configuration, and ABI fragments.
// ABOUTME: Single source of truth for the magic numbers referenced across the UI apps; selects between `mainnet` (default) and `medi` (Sepolia testnet) profiles via the `VITE_CROWDFUND_PROFILE` build-time env var.

/** Deployment profile — selects which set of contract constants the UI uses. */
export type CrowdfundProfile = 'mainnet' | 'medi'

/** Sale size + lifecycle parameters that vary between deployments. Mirrors
 *  what the contracts were deployed with — must stay in lockstep with the
 *  on-chain values for the active profile. */
export interface CrowdfundConstants {
  /** Sale size parameters (USDC, 6 decimals) */
  readonly BASE_SALE: bigint
  readonly MAX_SALE: bigint
  readonly MIN_SALE: bigint
  readonly ELASTIC_TRIGGER: bigint
  /** USDC per ARM (6-decimal USDC = 1e6). */
  readonly ARM_PRICE: bigint
  readonly MAX_SEEDS: number
  readonly LAUNCH_TEAM_HOP1_BUDGET: number
  readonly LAUNCH_TEAM_HOP2_BUDGET: number
  readonly MIN_COMMIT: bigint
  /** Window / phase durations (seconds). */
  readonly WINDOW_DURATION: number
  readonly LAUNCH_TEAM_INVITE_PERIOD: number
  readonly CLAIM_DEADLINE_DURATION: number
  /** Matches ArmadaGovernor.QUIET_PERIOD_DURATION. */
  readonly GOVERNANCE_QUIET_PERIOD: number
  readonly HOP2_FLOOR_BPS: number
}

/** Per-hop configuration matching the contract's hopConfigs[3] */
export interface HopConfig {
  readonly ceilingBps: number
  readonly capUsdc: bigint
  readonly maxInvites: number
  readonly maxInvitesReceived: number
}

const CONSTANTS_BY_PROFILE: Record<CrowdfundProfile, CrowdfundConstants> = {
  mainnet: {
    BASE_SALE: 1_200_000n * 10n ** 6n,
    MAX_SALE: 1_800_000n * 10n ** 6n,
    MIN_SALE: 1_000_000n * 10n ** 6n,
    ELASTIC_TRIGGER: 1_500_000n * 10n ** 6n,
    ARM_PRICE: 1_000_000n,
    MAX_SEEDS: 160,
    LAUNCH_TEAM_HOP1_BUDGET: 60,
    LAUNCH_TEAM_HOP2_BUDGET: 60,
    MIN_COMMIT: 10n * 10n ** 6n,
    WINDOW_DURATION: 21 * 24 * 60 * 60, // 21 days
    LAUNCH_TEAM_INVITE_PERIOD: 7 * 24 * 60 * 60, // 7 days
    CLAIM_DEADLINE_DURATION: 1095 * 24 * 60 * 60, // 3 years
    GOVERNANCE_QUIET_PERIOD: 7 * 24 * 60 * 60, // 7 days
    HOP2_FLOOR_BPS: 500, // 5%
  },
  medi: {
    BASE_SALE: 1_000n * 10n ** 6n,
    MAX_SALE: 1_500n * 10n ** 6n,
    MIN_SALE: 800n * 10n ** 6n,
    ELASTIC_TRIGGER: 1_250n * 10n ** 6n,
    ARM_PRICE: 1_000_000n,
    MAX_SEEDS: 25,
    LAUNCH_TEAM_HOP1_BUDGET: 15,
    LAUNCH_TEAM_HOP2_BUDGET: 15,
    MIN_COMMIT: 1n * 10n ** 6n,
    WINDOW_DURATION: 14 * 24 * 60 * 60, // 14 days
    LAUNCH_TEAM_INVITE_PERIOD: 14 * 24 * 60 * 60, // 14 days (equal to WINDOW_DURATION on medi-Sepolia)
    CLAIM_DEADLINE_DURATION: 60 * 24 * 60 * 60, // 60 days
    GOVERNANCE_QUIET_PERIOD: 1 * 24 * 60 * 60, // 1 day
    HOP2_FLOOR_BPS: 500, // 5%
  },
}

const HOP_CONFIGS_BY_PROFILE: Record<
  CrowdfundProfile,
  readonly [HopConfig, HopConfig, HopConfig]
> = {
  mainnet: [
    { ceilingBps: 7000, capUsdc: 15_000n * 10n ** 6n, maxInvites: 3, maxInvitesReceived: 1 },
    { ceilingBps: 4500, capUsdc: 4_000n * 10n ** 6n, maxInvites: 2, maxInvitesReceived: 10 },
    { ceilingBps: 0, capUsdc: 1_000n * 10n ** 6n, maxInvites: 0, maxInvitesReceived: 20 },
  ],
  medi: [
    { ceilingBps: 7000, capUsdc: 50n * 10n ** 6n, maxInvites: 3, maxInvitesReceived: 1 },
    { ceilingBps: 4500, capUsdc: 20n * 10n ** 6n, maxInvites: 2, maxInvitesReceived: 10 },
    { ceilingBps: 0, capUsdc: 10n * 10n ** 6n, maxInvites: 0, maxInvitesReceived: 20 },
  ],
}

/** Resolve the active profile from the `VITE_CROWDFUND_PROFILE` env var.
 *  Vite replaces `import.meta.env.VITE_*` at build time in the consuming
 *  apps; vitest exposes the same surface. We cast `import.meta` because
 *  this package's tsconfig doesn't reference `vite/client` (kept Vite-free
 *  so non-Vite consumers — say, future server-side tests — can import the
 *  module without pulling vite types in). Unknown / unset values fall back
 *  to `mainnet`, so existing mainnet-targeted builds need no env change. */
function resolveCrowdfundProfile(): CrowdfundProfile {
  const env = (import.meta as ImportMeta & { env?: { VITE_CROWDFUND_PROFILE?: string } }).env
  const raw = env?.VITE_CROWDFUND_PROFILE
  if (raw === 'medi') return 'medi'
  return 'mainnet'
}

export const CROWDFUND_PROFILE: CrowdfundProfile = resolveCrowdfundProfile()

export const CROWDFUND_CONSTANTS: CrowdfundConstants =
  CONSTANTS_BY_PROFILE[CROWDFUND_PROFILE]

export const HOP_CONFIGS: readonly [HopConfig, HopConfig, HopConfig] =
  HOP_CONFIGS_BY_PROFILE[CROWDFUND_PROFILE]

/** ABI fragments for event parsing and contract reads.
 *  Must match the indexed flags + param shape of the on-chain events exactly
 *  — ethers' `Interface.parseLog` looks up the fragment by topic[0] (selector,
 *  insensitive to indexed flags) but then decodes topics vs data using the
 *  fragment's indexed/non-indexed layout. A mismatch makes parseLog throw,
 *  which our event parser silently swallows, so the corresponding events go
 *  missing from the graph entirely. Cross-check against the events block in
 *  `contracts/crowdfund/ArmadaCrowdfund.sol` whenever this list changes. */
export const CROWDFUND_ABI_FRAGMENTS = [
  'event ArmLoaded(address indexed caller, uint256 balance, uint256 required)',
  'event SeedAdded(address indexed seed)',
  'event Invited(address indexed inviter, address indexed invitee, uint8 indexed hop, uint256 nonce)',
  'event LaunchTeamInvited(address indexed invitee, uint8 hop)',
  'event Committed(address indexed participant, uint8 indexed hop, uint256 amount)',
  'event Finalized(uint256 saleSize, uint256 allocatedArm, uint256 netProceeds, bool refundMode, uint256 cappedDemand, uint256 totalCommitted)',
  'event Cancelled(address indexed caller, uint256 timestamp)',
  'event Allocated(address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate)',
  'event AllocatedHop(address indexed participant, uint8 indexed hop, uint256 acceptedUsdc)',
  'event RefundClaimed(address indexed participant, uint256 usdcAmount)',
  'event InviteNonceRevoked(address indexed inviter, uint256 nonce)',
  'event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount)',
  'function phase() view returns (uint8)',
  'function armLoaded() view returns (bool)',
  'function totalCommitted() view returns (uint256)',
  'function cappedDemand() view returns (uint256)',
  'function getEstimatedCappedDemand() view returns (uint256 globalCapped, uint256[3] perHopCapped)',
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
