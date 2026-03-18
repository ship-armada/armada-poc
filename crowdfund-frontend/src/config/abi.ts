// ABOUTME: Human-readable ABI definitions for all contract interactions.
// ABOUTME: Uses ethers.js v6 Interface.from() format, no compiled artifacts needed.

export const CROWDFUND_ABI = [
  // Admin actions (Setup)
  'function addSeed(address seed) external',
  'function addSeeds(address[] calldata seeds) external',
  'function startInvitations() external',
  'function finalize() external',
  'function withdrawProceeds() external',
  'function withdrawUnallocatedArm() external',
  'function pause() external',
  'function unpause() external',
  'function permissionlessCancel() external',

  // Participant actions
  'function invite(address invitee, uint8 inviterHop) external',
  'function commit(uint256 amount, uint8 hop) external',
  'function claim() external',
  'function refund() external',

  // State variables (public getters)
  'function phase() view returns (uint8)',
  'function admin() view returns (address)',
  'function usdc() view returns (address)',
  'function armToken() view returns (address)',
  'function treasury() view returns (address)',
  'function paused() view returns (bool)',
  'function totalCommitted() view returns (uint256)',
  'function saleSize() view returns (uint256)',
  'function totalAllocated() view returns (uint256)',
  'function totalAllocatedUsdc() view returns (uint256)',
  'function invitationStart() view returns (uint256)',
  'function invitationEnd() view returns (uint256)',
  'function commitmentStart() view returns (uint256)',
  'function commitmentEnd() view returns (uint256)',
  'function participants(address, uint8) view returns (bool isWhitelisted, uint16 invitesReceived, uint256 committed, uint256 allocation, uint256 refund, bool claimed, address invitedBy, uint16 invitesSent)',
  'function participantNodes(uint256) view returns (address addr, uint8 hop)',
  'function hopStats(uint256) view returns (uint256 totalCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function hopConfigs(uint256) view returns (uint16 ceilingBps, uint256 capUsdc, uint8 maxInvites)',
  'function finalCeilings(uint256) view returns (uint256)',
  'function finalDemands(uint256) view returns (uint256)',
  'function totalProceedsAccrued() view returns (uint256)',
  'function totalArmClaimed() view returns (uint256)',
  'function proceedsWithdrawnAmount() view returns (uint256)',
  'function unallocatedArmWithdrawn() view returns (bool)',
  'function treasuryLeftoverUsdc() view returns (uint256)',

  // View functions
  'function getHopStats(uint8 hop) view returns (uint256 totalCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function getSaleStats() view returns (uint256 totalCommitted, uint8 phase, uint256 invitationEnd, uint256 commitmentEnd)',
  'function isWhitelisted(address addr, uint8 hop) view returns (bool)',
  'function getCommitment(address addr, uint8 hop) view returns (uint256 committed)',
  'function getInvitesRemaining(address addr, uint8 hop) view returns (uint16)',
  'function getInvitesReceived(address addr, uint8 hop) view returns (uint16)',
  'function getInviteEdge(address invitee, uint8 hop) view returns (address inviter)',
  'function getAllocation(address addr) view returns (uint256 allocation, uint256 refund, bool claimed)',
  'function getAllocationAtHop(address addr, uint8 hop) view returns (uint256 allocation, uint256 refund, bool claimed)',
  'function getEffectiveCap(address addr, uint8 hop) view returns (uint256)',
  'function getParticipantCount() view returns (uint256)',

  // Events
  'event SeedAdded(address indexed seed)',
  'event InvitationStarted(uint256 invitationEnd, uint256 commitmentStart, uint256 commitmentEnd)',
  'event Invited(address indexed inviter, address indexed invitee, uint8 hop)',
  'event InviteAdded(address indexed inviter, address indexed invitee, uint8 hop, uint16 newInviteCount)',
  'event Committed(address indexed participant, uint256 amount, uint256 totalForParticipant, uint8 hop)',
  'event SaleFinalized(uint256 saleSize, uint256 totalAllocUsdc, uint256 totalAllocArm, uint256 treasuryLeftoverUsdc)',
  'event SaleCanceled(uint256 totalCommitted)',
  'event Claimed(address indexed participant, uint256 armAmount, uint256 usdcRefund)',
  'event Refunded(address indexed participant, uint256 amount)',
  'event ProceedsWithdrawn(address indexed treasury, uint256 amount)',
  'event UnallocatedArmWithdrawn(address indexed treasury, uint256 amount)',
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
