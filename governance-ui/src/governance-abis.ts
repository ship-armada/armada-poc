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

export const VOTING_LOCKER_ABI = [
  'function lock(uint256 amount)',
  'function unlock(uint256 amount)',
  'function getLockedBalance(address account) view returns (uint256)',
  'function getPastLockedBalance(address account, uint256 blockNumber) view returns (uint256)',
  'function totalLocked() view returns (uint256)',
  'function getPastTotalLocked(uint256 blockNumber) view returns (uint256)',
  'function numCheckpoints(address account) view returns (uint256)',
  'function armToken() view returns (address)',
  'event TokensLocked(address indexed user, uint256 amount, uint256 newLockedBalance)',
  'event TokensUnlocked(address indexed user, uint256 amount, uint256 newLockedBalance)',
]

export const GOVERNOR_ABI = [
  // Write functions
  'function propose(uint8 proposalType, address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function castVote(uint256 proposalId, uint8 support)',
  'function queue(uint256 proposalId)',
  'function execute(uint256 proposalId) payable',
  'function cancel(uint256 proposalId)',
  // Read functions
  'function proposalCount() view returns (uint256)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function getProposal(uint256 proposalId) view returns (address proposer, uint8 proposalType, uint256 voteStart, uint256 voteEnd, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, uint256 snapshotBlock)',
  'function getProposalActions(uint256 proposalId) view returns (address[] targets, uint256[] values, bytes[] calldatas)',
  'function quorum(uint256 proposalId) view returns (uint256)',
  'function proposalThreshold() view returns (uint256)',
  'function hasVoted(uint256 proposalId, address voter) view returns (bool)',
  'function voteChoice(uint256 proposalId, address voter) view returns (uint8)',
  'function treasuryAddress() view returns (address)',
  'function getExcludedFromQuorum() view returns (address[])',
  'function votingLocker() view returns (address)',
  'function armToken() view returns (address)',
  // Events
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint8 proposalType, uint256 voteStart, uint256 voteEnd, string description)',
  'event VoteCast(address indexed voter, uint256 indexed proposalId, uint8 support, uint256 weight)',
  'event ProposalQueued(uint256 indexed proposalId, bytes32 timelockId)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProposalCanceled(uint256 indexed proposalId)',
]

export const TREASURY_ABI = [
  // Write functions
  'function distribute(address token, address recipient, uint256 amount)',
  'function createClaim(address token, address beneficiary, uint256 amount) returns (uint256)',
  'function exerciseClaim(uint256 claimId, uint256 amount)',
  'function setSteward(address _steward)',
  'function stewardSpend(address token, address recipient, uint256 amount)',
  // Read functions
  'function getBalance(address token) view returns (uint256)',
  'function claimCount() view returns (uint256)',
  'function claims(uint256 claimId) view returns (address token, address beneficiary, uint256 amount, uint256 exercised, uint256 createdAt)',
  'function getBeneficiaryClaims(address beneficiary) view returns (uint256[])',
  'function getClaimRemaining(uint256 claimId) view returns (uint256)',
  'function getStewardBudget(address token) view returns (uint256 budget, uint256 spent, uint256 remaining)',
  'function steward() view returns (address)',
  'function owner() view returns (address)',
  // Events
  'event DirectDistribution(address indexed token, address indexed recipient, uint256 amount)',
  'event ClaimCreated(uint256 indexed claimId, address indexed beneficiary, address token, uint256 amount)',
  'event ClaimExercised(uint256 indexed claimId, address indexed beneficiary, uint256 amount)',
  'event StewardSpent(address indexed token, address indexed recipient, uint256 amount, uint256 budgetRemaining)',
  'event StewardUpdated(address indexed oldSteward, address indexed newSteward)',
  'event OwnerUpdated(address indexed oldOwner, address indexed newOwner)',
]

export const STEWARD_ABI = [
  // Write functions
  'function electSteward(address _steward)',
  'function removeSteward()',
  'function vetoAction(uint256 actionId)',
  'function proposeAction(address target, bytes data, uint256 value) returns (uint256)',
  'function executeAction(uint256 actionId)',
  'function setActionDelay(uint256 _actionDelay)',
  // Read functions
  'function currentSteward() view returns (address)',
  'function termStart() view returns (uint256)',
  'function termEnd() view returns (uint256)',
  'function isStewardActive() view returns (bool)',
  'function actionCount() view returns (uint256)',
  'function getAction(uint256 actionId) view returns (address target, uint256 value, uint256 timestamp, bool executed, bool vetoed, uint256 executeAfter)',
  'function actionDelay() view returns (uint256)',
  'function treasury() view returns (address)',
  'function timelock() view returns (address)',
  'function TERM_DURATION() view returns (uint256)',
  // Events
  'event StewardElected(address indexed steward, uint256 termStart, uint256 termEnd)',
  'event StewardRemoved(address indexed steward)',
  'event ActionProposed(uint256 indexed actionId, address indexed target, uint256 value, uint256 executeAfter)',
  'event ActionExecuted(uint256 indexed actionId)',
  'event ActionVetoed(uint256 indexed actionId)',
  'event ActionDelayUpdated(uint256 oldDelay, uint256 newDelay)',
]

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]
