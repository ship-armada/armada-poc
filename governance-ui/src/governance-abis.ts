// ABOUTME: Inline ABI definitions for all Armada governance contracts.
// ABOUTME: Uses ethers.js function signature format for lightweight imports.

export const ARM_TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

export const ERC20_VOTES_ABI = [
  'function delegate(address delegatee)',
  'function delegates(address account) view returns (address)',
  'function getVotes(address account) view returns (uint256)',
  'function getPastVotes(address account, uint256 blockNumber) view returns (uint256)',
  'function getPastTotalSupply(uint256 blockNumber) view returns (uint256)',
  'event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)',
  'event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance)',
]

export const GOVERNOR_ABI = [
  // Write functions
  'function propose(uint8 proposalType, address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function castVote(uint256 proposalId, uint8 support)',
  'function queue(uint256 proposalId)',
  'function execute(uint256 proposalId) payable',
  'function cancel(uint256 proposalId)',
  'function proposeStewardSpend(address[] tokens, address[] recipients, uint256[] amounts, string description) returns (uint256)',
  'function veto(uint256 proposalId, bytes32 rationaleHash)',
  'function resolveRatification(uint256 ratificationId)',
  // Read functions
  'function proposalCount() view returns (uint256)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function getProposal(uint256 proposalId) view returns (address proposer, uint8 proposalType, uint256 voteStart, uint256 voteEnd, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 snapshotBlock, uint256 snapshotEligibleSupply)',
  'function getProposalActions(uint256 proposalId) view returns (address[] targets, uint256[] values, bytes[] calldatas)',
  'function quorum(uint256 proposalId) view returns (uint256)',
  'function proposalThreshold() view returns (uint256)',
  'function hasVoted(uint256 proposalId, address voter) view returns (bool)',
  'function voteChoice(uint256 proposalId, address voter) view returns (uint8)',
  'function treasuryAddress() view returns (address)',
  'function getExcludedFromQuorum() view returns (address[])',
  'function armToken() view returns (address)',
  'function stewardContract() view returns (address)',
  'function securityCouncil() view returns (address)',
  'function windDownActive() view returns (bool)',
  'function ratificationOf(uint256 ratificationId) view returns (uint256)',
  'function vetoRatificationId(uint256 vetoedProposalId) view returns (uint256)',
  // Events
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 proposalType, uint256 voteStart, uint256 voteEnd, string description)',
  'event VoteCast(address indexed voter, uint256 indexed proposalId, uint8 support, uint256 weight)',
  'event VoteChanged(address indexed voter, uint256 indexed proposalId, uint8 oldSupport, uint8 newSupport, uint256 weight)',
  'event ProposalQueued(uint256 indexed proposalId, bytes32 timelockId)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProposalCanceled(uint256 indexed proposalId)',
  'event ProposalVetoed(uint256 indexed proposalId, bytes32 rationaleHash, uint256 ratificationId)',
  'event RatificationResolved(uint256 indexed ratificationId, bool vetoUpheld)',
  'event SecurityCouncilEjected(uint256 indexed ratificationId)',
  'event SecurityCouncilUpdated(address indexed oldSC, address indexed newSC)',
]

export const TREASURY_ABI = [
  // Write functions
  'function distribute(address token, address recipient, uint256 amount)',
  'function stewardSpend(address token, address recipient, uint256 amount)',
  // Read functions
  'function getBalance(address token) view returns (uint256)',
  'function getStewardBudget(address token) view returns (uint256 budget, uint256 spent, uint256 remaining)',
  'function owner() view returns (address)',
  'function getOutflowConfig(address token) view returns (uint256 windowDuration, uint256 limitBps, uint256 limitAbsolute, uint256 floorAbsolute)',
  // Events
  'event DirectDistribution(address indexed token, address indexed recipient, uint256 amount)',
  'event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining)',
]

export const STEWARD_ABI = [
  // Write functions (called via timelock/governance only)
  'function electSteward(address _steward)',
  'function removeSteward()',
  // Read functions
  'function currentSteward() view returns (address)',
  'function termStart() view returns (uint256)',
  'function termEnd() view returns (uint256)',
  'function isStewardActive() view returns (bool)',
  'function timelock() view returns (address)',
  'function TERM_DURATION() view returns (uint256)',
  // Events
  'event StewardElected(address indexed steward, uint256 termStart, uint256 termEnd)',
  'event StewardRemoved(address indexed steward)',
]

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]

export const WIND_DOWN_ABI = [
  'function triggered() view returns (bool)',
  'function windDownDeadline() view returns (uint256)',
  'function revenueThreshold() view returns (uint256)',
  'function triggerWindDown()',
  'function sweepToken(address token)',
  'function sweepETH()',
]

export const REDEMPTION_ABI = [
  'function circulatingSupply() view returns (uint256)',
  'function redeem(uint256 armAmount, address[] tokens, bool includeETH)',
]

export const REVENUE_COUNTER_ABI = [
  'function recognizedRevenueUsd() view returns (uint256)',
]
