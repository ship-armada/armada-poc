// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./IArmadaGovernance.sol";

/// @title ArmadaGovernor — Custom governance with typed proposals and token locking
/// @notice Implements the Armada governance spec: proposal lifecycle, per-type quorum/timing,
///         voting via locked tokens, and timelock execution.
contract ArmadaGovernor is ReentrancyGuard {

    // ============ Types ============

    struct Proposal {
        uint256 id;
        address proposer;
        ProposalType proposalType;

        // Timing (timestamps)
        uint256 voteStart;
        uint256 voteEnd;
        uint256 executionDelay;

        // Snapshot block for voting power
        uint256 snapshotBlock;

        // Vote tallies
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;

        // State tracking
        bool executed;
        bool canceled;
        bool queued;

        // Execution data
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        string description;
    }

    // ============ State ============

    IVotingLocker public immutable votingLocker;
    IERC20 public immutable armToken;
    TimelockController public immutable timelock;
    address public immutable treasuryAddress;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;

    // Voter tracking per proposal
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => uint8)) public voteChoice;

    // Proposal type parameters
    mapping(ProposalType => ProposalParams) public proposalTypeParams;

    // Proposal threshold: 0.1% = 10 bps
    uint256 public constant PROPOSAL_THRESHOLD_BPS = 10;

    // ============ Events ============

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        uint256 voteStart,
        uint256 voteEnd,
        string description
    );
    event VoteCast(address indexed voter, uint256 indexed proposalId, uint8 support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, bytes32 timelockId);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCanceled(uint256 indexed proposalId);

    // ============ Constructor ============

    constructor(
        address _votingLocker,
        address _armToken,
        address payable _timelock,
        address _treasuryAddress
    ) {
        require(_votingLocker != address(0), "ArmadaGovernor: zero votingLocker");
        require(_armToken != address(0), "ArmadaGovernor: zero armToken");
        require(_timelock != address(0), "ArmadaGovernor: zero timelock");
        require(_treasuryAddress != address(0), "ArmadaGovernor: zero treasury");
        votingLocker = IVotingLocker(_votingLocker);
        armToken = IERC20(_armToken);
        timelock = TimelockController(_timelock);
        treasuryAddress = _treasuryAddress;

        // Standard proposals: 2d delay, 5d voting, 2d execution, 20% quorum
        proposalTypeParams[ProposalType.ParameterChange] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 5 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

        proposalTypeParams[ProposalType.Treasury] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 5 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

        // Extended: 2d delay, 7d voting, 4d execution, 30% quorum
        proposalTypeParams[ProposalType.StewardElection] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 7 days,
            executionDelay: 4 days,
            quorumBps: 3000
        });
    }

    // ============ Proposal Lifecycle ============

    /// @notice Create a new proposal
    /// @param proposalType Type of proposal (determines quorum & timing)
    /// @param targets Target addresses for execution
    /// @param values ETH values for each call
    /// @param calldatas Encoded function calls
    /// @param description Human-readable description
    function propose(
        ProposalType proposalType,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external returns (uint256) {
        require(targets.length > 0, "ArmadaGovernor: empty proposal");
        require(
            targets.length == values.length && targets.length == calldatas.length,
            "ArmadaGovernor: length mismatch"
        );
        _checkProposalThreshold(msg.sender);

        uint256 proposalId = ++proposalCount;
        _initProposal(proposalId, proposalType, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        emit ProposalCreated(
            proposalId, msg.sender, proposalType,
            p.voteStart, p.voteEnd, description
        );
        return proposalId;
    }

    /// @dev Check that proposer has enough locked tokens (0.1% of total supply)
    function _checkProposalThreshold(address proposer) internal view {
        uint256 proposerVotes = votingLocker.getPastLockedBalance(proposer, block.number - 1);
        uint256 threshold = (armToken.totalSupply() * PROPOSAL_THRESHOLD_BPS) / 10000;
        require(proposerVotes >= threshold, "ArmadaGovernor: below proposal threshold");
    }

    /// @dev Initialize proposal scalar fields
    function _initProposal(
        uint256 proposalId,
        ProposalType proposalType,
        string memory description
    ) internal {
        ProposalParams storage params = proposalTypeParams[proposalType];
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.proposalType = proposalType;
        p.snapshotBlock = block.number - 1;
        p.voteStart = block.timestamp + params.votingDelay;
        p.voteEnd = p.voteStart + params.votingPeriod;
        p.executionDelay = params.executionDelay;
        p.description = description;
    }

    /// @notice Cast a vote on a proposal
    /// @param proposalId Proposal to vote on
    /// @param support 0=Against, 1=For, 2=Abstain
    function castVote(uint256 proposalId, uint8 support) external {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "ArmadaGovernor: unknown proposal");
        require(block.timestamp >= p.voteStart, "ArmadaGovernor: voting not started");
        require(block.timestamp <= p.voteEnd, "ArmadaGovernor: voting ended");
        require(!hasVoted[proposalId][msg.sender], "ArmadaGovernor: already voted");
        require(support <= 2, "ArmadaGovernor: invalid vote type");

        uint256 weight = votingLocker.getPastLockedBalance(msg.sender, p.snapshotBlock);
        require(weight > 0, "ArmadaGovernor: no voting power");

        hasVoted[proposalId][msg.sender] = true;
        voteChoice[proposalId][msg.sender] = support;

        if (support == 0) {
            p.againstVotes += weight;
        } else if (support == 1) {
            p.forVotes += weight;
        } else {
            p.abstainVotes += weight;
        }

        emit VoteCast(msg.sender, proposalId, support, weight);
    }

    /// @notice Queue a succeeded proposal to the timelock
    function queue(uint256 proposalId) external {
        require(state(proposalId) == ProposalState.Succeeded, "ArmadaGovernor: not succeeded");

        Proposal storage p = _proposals[proposalId];
        p.queued = true;

        bytes32 timelockId = timelock.hashOperationBatch(
            p.targets, p.values, p.calldatas, 0, _proposalSalt(proposalId)
        );

        timelock.scheduleBatch(
            p.targets, p.values, p.calldatas,
            0, // no predecessor
            _proposalSalt(proposalId),
            p.executionDelay
        );

        emit ProposalQueued(proposalId, timelockId);
    }

    /// @notice Execute a queued proposal after timelock delay
    function execute(uint256 proposalId) external payable nonReentrant {
        require(state(proposalId) == ProposalState.Queued, "ArmadaGovernor: not queued");

        Proposal storage p = _proposals[proposalId];
        p.executed = true;

        timelock.executeBatch{value: msg.value}(
            p.targets, p.values, p.calldatas,
            0, // no predecessor
            _proposalSalt(proposalId)
        );

        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancel a proposal (proposer only, while Pending)
    function cancel(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "ArmadaGovernor: unknown proposal");
        require(msg.sender == p.proposer, "ArmadaGovernor: not proposer");
        require(state(proposalId) == ProposalState.Pending, "ArmadaGovernor: not pending");

        p.canceled = true;

        emit ProposalCanceled(proposalId);
    }

    // ============ View Functions ============

    /// @notice Get current state of a proposal
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        require(p.id != 0, "ArmadaGovernor: unknown proposal");

        if (p.canceled) return ProposalState.Canceled;
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp < p.voteStart) return ProposalState.Pending;
        if (block.timestamp <= p.voteEnd) return ProposalState.Active;

        // After voting ends: check quorum and majority
        if (!_quorumReached(proposalId) || !_voteSucceeded(proposalId)) {
            return ProposalState.Defeated;
        }

        if (p.queued) return ProposalState.Queued;
        return ProposalState.Succeeded;
    }

    /// @notice Calculate quorum for a proposal: X% of ARM supply outside treasury
    function quorum(uint256 proposalId) public view returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        uint256 totalSupply = armToken.totalSupply();
        uint256 treasuryBalance = armToken.balanceOf(treasuryAddress);
        uint256 eligibleSupply = totalSupply - treasuryBalance;
        uint256 quorumBps = proposalTypeParams[p.proposalType].quorumBps;
        return (eligibleSupply * quorumBps) / 10000;
    }

    /// @notice Get proposal details
    function getProposal(uint256 proposalId) external view returns (
        address proposer,
        ProposalType proposalType,
        uint256 voteStart,
        uint256 voteEnd,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 snapshotBlock
    ) {
        Proposal storage p = _proposals[proposalId];
        return (
            p.proposer, p.proposalType, p.voteStart, p.voteEnd,
            p.forVotes, p.againstVotes, p.abstainVotes, p.snapshotBlock
        );
    }

    /// @notice Get proposal execution data
    function getProposalActions(uint256 proposalId) external view returns (
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas
    ) {
        Proposal storage p = _proposals[proposalId];
        return (p.targets, p.values, p.calldatas);
    }

    /// @notice Get proposal threshold (minimum locked tokens to propose)
    function proposalThreshold() external view returns (uint256) {
        return (armToken.totalSupply() * PROPOSAL_THRESHOLD_BPS) / 10000;
    }

    // ============ Internal ============

    function _quorumReached(uint256 proposalId) internal view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        // Abstain counts toward quorum but not majority
        return (p.forVotes + p.abstainVotes) >= quorum(proposalId);
    }

    function _voteSucceeded(uint256 proposalId) internal view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.forVotes > p.againstVotes;
    }

    /// @dev Unique salt per proposal for timelock deduplication
    function _proposalSalt(uint256 proposalId) internal pure returns (bytes32) {
        return bytes32(proposalId);
    }
}
