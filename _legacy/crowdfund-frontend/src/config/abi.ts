// ABOUTME: Human-readable ABI definitions for all contract interactions.
// ABOUTME: Uses ethers.js v6 Interface.from() format, no compiled artifacts needed.

export const CROWDFUND_ABI = [
  // Admin actions (Setup)
  'function addSeed(address seed) external',
  'function addSeeds(address[] calldata seeds) external',
  'function loadArm() external',
  'function finalize() external',
  'function cancel() external',
  'function withdrawUnallocatedArm() external',
  'function pause() external',
  'function unpause() external',

  // Participant actions
  'function invite(address invitee, uint8 inviterHop) external',
  'function commit(uint8 hop, uint256 amount) external',
  'function claim(address delegate) external',
  'function claimRefund() external',

  // Launch team actions
  'function launchTeamInvite(address invitee, uint8 fromHop) external',

  // State variables (public getters)
  'function phase() view returns (uint8)',
  'function launchTeam() view returns (address)',
  'function usdc() view returns (address)',
  'function armToken() view returns (address)',
  'function treasury() view returns (address)',
  'function paused() view returns (bool)',
  'function armLoaded() view returns (bool)',
  'function refundMode() view returns (bool)',
  'function totalCommitted() view returns (uint256)',
  'function saleSize() view returns (uint256)',
  'function totalAllocatedArm() view returns (uint256)',
  'function totalAllocatedUsdc() view returns (uint256)',
  'function windowStart() view returns (uint256)',
  'function windowEnd() view returns (uint256)',
  'function launchTeamInviteEnd() view returns (uint256)',
  'function participants(address, uint8) view returns (bool isWhitelisted, uint16 invitesReceived, uint256 committed, address invitedBy, uint16 invitesSent)',
  'function participantNodes(uint256) view returns (address addr, uint8 hop)',
  'function hopStats(uint256) view returns (uint256 totalCommitted, uint256 cappedCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function hopConfigs(uint256) view returns (uint16 ceilingBps, uint256 capUsdc, uint8 maxInvites, uint16 maxInvitesReceived)',
  'function finalCeilings(uint256) view returns (uint256)',
  'function finalDemands(uint256) view returns (uint256)',
  'function totalArmTransferred() view returns (uint256)',
  'function claimDeadline() view returns (uint256)',
  'function securityCouncil() view returns (address)',
  'function claimed(address) view returns (bool)',

  // View functions
  'function getHopStats(uint8 hop) view returns (uint256 totalCommitted, uint256 cappedCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function getSaleStats() view returns (uint256 totalCommitted, uint8 phase, uint256 windowStart, uint256 windowEnd)',
  'function isWhitelisted(address addr, uint8 hop) view returns (bool)',
  'function getCommitment(address addr, uint8 hop) view returns (uint256 committed)',
  'function getInvitesRemaining(address addr, uint8 hop) view returns (uint16)',
  'function getInvitesReceived(address addr, uint8 hop) view returns (uint16)',
  'function getInviteEdge(address invitee, uint8 hop) view returns (address inviter)',
  'function computeAllocation(address addr) view returns (uint256 armAmount, uint256 refundUsdc)',
  'function computeAllocationAtHop(address addr, uint8 hop) view returns (uint256 armAmount, uint256 refundUsdc)',
  'function getEffectiveCap(address addr, uint8 hop) view returns (uint256)',
  'function getParticipantCount() view returns (uint256)',
  'function getLaunchTeamBudgetRemaining() view returns (uint8 hop1Remaining, uint8 hop2Remaining)',

  // Events
  'event SeedAdded(address indexed seed)',
  'event Invited(address indexed inviter, address indexed invitee, uint8 hop, uint256 nonce)',
  'event InviteAdded(address indexed inviter, address indexed invitee, uint8 hop, uint16 newInviteCount)',
  'event Committed(address indexed participant, uint8 hop, uint256 amount)',
  'event Finalized(uint256 saleSize, uint256 allocatedArm, uint256 netProceeds, bool refundMode)',
  'event Cancelled()',
  'event Allocated(address indexed participant, uint256 armTransferred, uint256 refundUsdc, address delegate)',
  'event RefundClaimed(address indexed participant, uint256 usdcAmount)',
  'event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount)',
  'event ArmLoaded()',
] as const

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
] as const

export const MOCK_USDC_ABI = [
  ...ERC20_ABI,
  'function mint(address to, uint256 amount) external',
] as const
