// ABOUTME: Human-readable ABI definitions for all contract interactions.
// ABOUTME: Uses ethers.js v6 Interface.from() format, no compiled artifacts needed.

export const CROWDFUND_ABI = [
  // Admin actions (Setup)
  'function addSeed(address seed) external',
  'function addSeeds(address[] calldata seeds) external',
  'function startInvitations() external',
  'function finalize() external',
  'function withdrawProceeds(address treasury) external',
  'function withdrawUnallocatedArm(address treasury) external',

  // Participant actions
  'function invite(address invitee) external',
  'function commit(uint256 amount) external',
  'function claim() external',
  'function refund() external',

  // State variables (public getters)
  'function phase() view returns (uint8)',
  'function admin() view returns (address)',
  'function usdc() view returns (address)',
  'function armToken() view returns (address)',
  'function totalCommitted() view returns (uint256)',
  'function saleSize() view returns (uint256)',
  'function totalAllocated() view returns (uint256)',
  'function totalAllocatedUsdc() view returns (uint256)',
  'function invitationStart() view returns (uint256)',
  'function invitationEnd() view returns (uint256)',
  'function commitmentStart() view returns (uint256)',
  'function commitmentEnd() view returns (uint256)',
  'function participants(address) view returns (uint8 hop, bool isWhitelisted, uint256 committed, uint256 allocation, uint256 refund, bool claimed, address invitedBy, uint8 invitesSent)',
  'function participantList(uint256) view returns (address)',
  'function hopStats(uint8) view returns (uint256 totalCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function finalReserves(uint256) view returns (uint256)',
  'function finalDemands(uint256) view returns (uint256)',
  'function totalProceedsAccrued() view returns (uint256)',
  'function totalArmClaimed() view returns (uint256)',
  'function proceedsWithdrawnAmount() view returns (uint256)',
  'function unallocatedArmWithdrawn() view returns (bool)',

  // View functions
  'function getHopStats(uint8 hop) view returns (uint256 totalCommitted, uint32 uniqueCommitters, uint32 whitelistCount)',
  'function getSaleStats() view returns (uint256 totalCommitted, uint8 phase, uint256 invitationEnd, uint256 commitmentEnd)',
  'function isWhitelisted(address addr) view returns (bool)',
  'function getCommitment(address addr) view returns (uint256 committed, uint8 hop)',
  'function getInvitesRemaining(address addr) view returns (uint8)',
  'function getInviteEdge(address invitee) view returns (address inviter, uint8 hop)',
  'function getAllocation(address addr) view returns (uint256 allocation, uint256 refund, bool claimed)',
  'function getParticipantCount() view returns (uint256)',

  // Events
  'event SeedAdded(address indexed seed)',
  'event InvitationStarted(uint256 invitationEnd, uint256 commitmentStart, uint256 commitmentEnd)',
  'event Invited(address indexed inviter, address indexed invitee, uint8 hop)',
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
