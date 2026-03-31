// SPDX-License-Identifier: MIT
// ABOUTME: UUPS-upgradeable governance engine with typed proposals, per-type quorum/timing, and timelock execution.
// ABOUTME: Voting power comes from ARM token delegation (ERC20Votes), not from a separate locking contract.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ArmadaToken.sol";
import "./IArmadaGovernance.sol";
import "../crowdfund/IArmadaCrowdfund.sol";
import "./GovernorStringLib.sol";

/// @title ArmadaGovernor — UUPS-upgradeable governance with typed proposals and ERC20Votes delegation
/// @notice Implements the Armada governance spec: proposal lifecycle, per-type quorum/timing,
///         voting via delegated ARM tokens, and timelock execution. Upgradeable via UUPS,
///         gated by the timelock (requires extended governance proposal).
contract ArmadaGovernor is Initializable, ReentrancyGuardUpgradeable, UUPSUpgradeable {

    // ============ Custom Errors ============

    error Gov_NotDeployer();
    error Gov_ZeroAddress();
    error Gov_ZeroArmToken();
    error Gov_ZeroTimelock();
    error Gov_ZeroTreasury();
    error Gov_AlreadyInitialized();
    error Gov_AlreadyLocked();
    error Gov_AlreadyResolved();
    error Gov_AutoCreatedOnly();
    error Gov_BelowProposalThreshold();
    error Gov_BondAlreadyClaimed();
    error Gov_BondReturnFailed();
    error Gov_BondStillLocked();
    error Gov_BondTransferFailed();
    error Gov_CommunityOverrodeNoDoubleVeto();
    error Gov_EmptyProposal();
    error Gov_ExecutionDelayOutOfBounds();
    error Gov_GovernanceEnded();
    error Gov_ImmutableProposalType();
    error Gov_InvalidVoteType();
    error Gov_LengthMismatch();
    error Gov_NoBond();
    error Gov_NoVotingPower();
    error Gov_NotARatificationProposal();
    error Gov_NotCurrentSteward();
    error Gov_NotPaused();
    error Gov_NotPendingOrActive();
    error Gov_NotPending();
    error Gov_NotProposer();
    error Gov_NotQueued();
    error Gov_NotSecurityCouncil();
    error Gov_NotStewardProposal();
    error Gov_NotSucceeded();
    error Gov_NotTimelock();
    error Gov_NotWindDownContract();
    error Gov_ProposalNotInTerminalState();
    error Gov_QuietPeriodActive();
    error Gov_QuorumBpsOutOfBounds();
    error Gov_RatificationNotResolved();
    error Gov_SameVote();
    error Gov_SelectorAlreadyExtended();
    error Gov_SelectorNotExtended();
    error Gov_SelfPaymentNotAllowed();
    error Gov_StewardCalldataClassifiedAsExtended();
    error Gov_StewardChannelPaused();
    error Gov_StewardContractNotSet();
    error Gov_StewardNotActive();
    error Gov_UnknownProposal();
    error Gov_UseResolveRatification();
    error Gov_VotingEnded();
    error Gov_VotingNotEnded();
    error Gov_VotingNotStarted();
    error Gov_VotingDelayOutOfBounds();
    error Gov_VotingPeriodOutOfBounds();
    error Gov_WindDownAlreadyActive();
    error Gov_WindDownContractAlreadySet();
    error Gov_WindDownContractNotSet();
    error Gov_SCEjected();

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

        // Eligible ARM supply at proposal creation (totalSupply minus non-voteable balances).
        // Stored at creation time so quorum cannot shift during voting.
        uint256 snapshotEligibleSupply;

        // Quorum basis points snapshotted at proposal creation.
        // Stored per-proposal so governance param changes don't retroactively affect in-flight proposals.
        uint256 snapshotQuorumBps;

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

    ArmadaToken public armToken;
    TimelockController public timelock;
    address public treasuryAddress;
    address public deployer;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;

    /// @notice Addresses excluded from quorum denominator (e.g. crowdfund contract).
    /// ARM held by these addresses is non-voteable and should not inflate quorum requirements.
    address[] private _excludedFromQuorum;
    bool public excludedAddressesLocked;

    // Voter tracking per proposal
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => uint8)) public voteChoice;

    // Proposal type parameters
    mapping(ProposalType => ProposalParams) public proposalTypeParams;

    // Proposal threshold: 0.1% = 10 bps
    uint256 public constant PROPOSAL_THRESHOLD_BPS = 10;

    // Bounds for governance-updatable proposal parameters
    uint256 public constant MIN_VOTING_DELAY = 1 days;
    uint256 public constant MAX_VOTING_DELAY = 14 days;
    uint256 public constant MIN_VOTING_PERIOD = 1 days;
    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MIN_EXECUTION_DELAY = 1 days;
    uint256 public constant MAX_EXECUTION_DELAY = 14 days;
    uint256 public constant MIN_QUORUM_BPS = 500;   // 5%
    uint256 public constant MAX_QUORUM_BPS = 5000;  // 50%

    // Succeeded proposals must be queued within this window or they expire
    uint256 public constant QUEUE_GRACE_PERIOD = 14 days;

    // Absolute quorum floor: prevents governance passing on trivial turnout regardless
    // of how small the circulating delegated supply is. Quorum = max(percentage, floor).
    uint256 public constant QUORUM_FLOOR = 100_000 * 1e18;

    // Governance quiet period — no proposals allowed for this duration after crowdfund finalization.
    // One-time bootstrapping constant; not governable.
    address public crowdfundAddress;
    bool public crowdfundAddressLocked;
    uint256 public constant QUIET_PERIOD_DURATION = 7 days;

    // Wind-down integration: when triggered, governance permanently stops accepting new proposals.
    // The wind-down contract is registered via one-time setter; only it can flip the flag.
    bool public windDownActive;
    address public windDownContract;
    bool public windDownContractSet;

    // Steward contract: registered via one-time setter. The governor calls it to verify
    // that msg.sender is the elected steward when creating steward proposals.
    address public stewardContract;
    bool public stewardContractLocked;

    // Extended proposal classification: function selectors that force Extended type regardless
    // of what the proposer declared. Governance can add/remove selectors via extended proposal.
    mapping(bytes4 => bool) public extendedSelectors;
    bool public extendedSelectorsInitialized;

    // Treasury >5% threshold for automatic extended classification of distribute() calls.
    // The distribute selector is checked specially: if amount > 5% of treasury balance, Extended.
    bytes4 public constant DISTRIBUTE_SELECTOR = bytes4(keccak256("distribute(address,address,uint256)"));
    uint256 public constant TREASURY_EXTENDED_THRESHOLD_BPS = 500; // 5%

    // Proposal bond: 1,000 ARM posted at proposal creation (only when ARM is transferable).
    // Bond is always returned but with variable lock periods based on outcome.
    uint256 public constant PROPOSAL_BOND = 1_000 * 1e18;
    uint256 public constant BOND_LOCK_QUORUM_FAIL = 15 days;
    uint256 public constant BOND_LOCK_VOTE_FAIL = 45 days;

    struct BondInfo {
        address depositor;
        uint256 amount;
        uint256 unlockTime; // 0 = immediately claimable or not yet determined
        bool claimed;
    }
    mapping(uint256 => BondInfo) public proposalBonds;



    // ============ Veto & Ratification ============

    /// @notice Calldata hashes of proposals where community denied the SC's veto.
    /// Prevents the SC from vetoing identical proposal content twice.
    mapping(bytes32 => bool) public vetoDeniedHashes;

    /// @notice Maps ratification proposalId → original vetoed proposalId
    mapping(uint256 => uint256) public ratificationOf;

    /// @notice Maps vetoed proposalId → ratification proposalId (reverse lookup)
    mapping(uint256 => uint256) public vetoRatificationId;

    // ============ Steward Circuit Breaker ============

    /// @notice Number of consecutive steward proposals with participation below 30%.
    /// When this reaches CIRCUIT_BREAKER_THRESHOLD, the steward channel pauses.
    uint256 public consecutiveLowParticipationCount;

    /// @notice Whether the steward channel is currently paused due to circuit breaker.
    bool public stewardChannelPaused;

    /// @notice Tracks whether a steward proposal's participation has been resolved.
    mapping(uint256 => bool) public stewardProposalResolved;

    uint256 public constant CIRCUIT_BREAKER_THRESHOLD = 5;
    uint256 public constant CIRCUIT_BREAKER_PARTICIPATION_BPS = 3000; // 30%

    /// @notice Ordered list of steward proposal IDs for auto-resolution tracking.
    uint256[] private _stewardProposalIds;

    /// @notice Cursor into _stewardProposalIds; all entries before this index are resolved.
    uint256 private _stewardResolveIndex;

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
    event VoteChanged(address indexed voter, uint256 indexed proposalId, uint8 oldSupport, uint8 newSupport, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, bytes32 timelockId);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCanceled(uint256 indexed proposalId);
    event ProposalTypeParamsUpdated(ProposalType indexed proposalType, ProposalParams params);
    event CrowdfundAddressSet(address indexed crowdfund);

    event WindDownContractSet(address indexed windDownContract);
    event WindDownActivated();
    event ExtendedSelectorAdded(bytes4 indexed selector);
    event ExtendedSelectorRemoved(bytes4 indexed selector);
    event BondPosted(uint256 indexed proposalId, address indexed depositor, uint256 amount);
    event BondClaimed(uint256 indexed proposalId, address indexed depositor, uint256 amount);
    event StewardContractSet(address indexed steward);
    event ProposalVetoed(uint256 indexed proposalId, bytes32 rationaleHash, uint256 ratificationId);
    event RatificationResolved(uint256 indexed ratificationId, bool vetoUpheld);
    event SecurityCouncilEjected(uint256 indexed ratificationId);
    event StewardChannelPaused(uint256 indexed triggeringProposalId);
    event StewardChannelResumed();

    // ============ Constructor & Initializer ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the governor behind a UUPS proxy.
    /// @param _armToken ARM governance token address
    /// @param _timelock TimelockController address for execution
    /// @param _treasuryAddress Treasury contract address
    function initialize(
        address _armToken,
        address payable _timelock,
        address _treasuryAddress
    ) external initializer {
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        if (_armToken == address(0)) revert Gov_ZeroArmToken();
        if (_timelock == address(0)) revert Gov_ZeroTimelock();
        if (_treasuryAddress == address(0)) revert Gov_ZeroTreasury();
        armToken = ArmadaToken(_armToken);
        timelock = TimelockController(_timelock);
        treasuryAddress = _treasuryAddress;
        deployer = msg.sender;

        // Standard proposals: 2d delay, 7d voting, 2d execution, 20% quorum
        proposalTypeParams[ProposalType.Standard] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 7 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

        // Extended proposals: 2d delay, 14d voting, 7d execution, 30% quorum
        proposalTypeParams[ProposalType.Extended] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 14 days,
            executionDelay: 7 days,
            quorumBps: 3000
        });

        // VetoRatification: immediate voting, 7d period, no execution delay, 20% quorum.
        // These params bypass setProposalTypeParams() bounds (MIN_VOTING_DELAY=1d,
        // MIN_EXECUTION_DELAY=1d), making VetoRatification timing effectively immutable
        // via governance. Only the veto mechanism can create these proposals.
        proposalTypeParams[ProposalType.VetoRatification] = ProposalParams({
            votingDelay: 0,
            votingPeriod: 7 days,
            executionDelay: 0,
            quorumBps: 2000
        });

        // Steward: immediate voting, 7d review window, 2d timelock, 20% quorum.
        // Total lifecycle: 9 days (0d delay + 7d vote + 2d timelock).
        // Pass-by-default: passes unless quorum met AND majority votes AGAINST.
        // The 2d execution delay is intentional: it provides a veto buffer after the
        // pass-by-default voting window, giving tokenholders time to queue a
        // VetoRatification proposal before the steward spend executes.
        // These params bypass setProposalTypeParams() bounds, making Steward timing
        // effectively immutable via governance. Only proposeStewardSpend() creates these.
        proposalTypeParams[ProposalType.Steward] = ProposalParams({
            votingDelay: 0,
            votingPeriod: 7 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

    }

    /// @notice One-time setter: register function selectors that force Extended proposal
    /// classification. Any proposal containing a call to one of these selectors is
    /// automatically Extended regardless of what the proposer declared.
    /// Deployer-only; locks permanently after the first call.
    /// @param selectors Array of function selectors to register as extended
    function initExtendedSelectors(bytes4[] calldata selectors) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        if (extendedSelectorsInitialized) revert Gov_AlreadyInitialized();
        extendedSelectorsInitialized = true;
        for (uint256 i = 0; i < selectors.length; i++) {
            extendedSelectors[selectors[i]] = true;
        }
    }

    // ============ Quorum Exclusion ============

    /// @notice One-time setter: register addresses whose ARM balances are excluded from quorum.
    /// Deployer-only; locks permanently after the first call.
    /// Intended for contracts holding non-voteable ARM (e.g. crowdfund).
    function setExcludedAddresses(address[] calldata addrs) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        if (excludedAddressesLocked) revert Gov_AlreadyLocked();

        excludedAddressesLocked = true;
        for (uint256 i = 0; i < addrs.length; i++) {
            if (addrs[i] == address(0)) revert Gov_ZeroAddress();
            _excludedFromQuorum.push(addrs[i]);
        }
    }

    /// @notice View excluded addresses for transparency
    function getExcludedFromQuorum() external view returns (address[] memory) {
        return _excludedFromQuorum;
    }

    /// @notice One-time setter: register the crowdfund contract for quiet period checks.
    /// Deployer-only; locks permanently after the first call.
    function setCrowdfundAddress(address _crowdfund) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        if (crowdfundAddressLocked) revert Gov_AlreadyLocked();
        if (_crowdfund == address(0)) revert Gov_ZeroAddress();

        crowdfundAddressLocked = true;
        crowdfundAddress = _crowdfund;

        emit CrowdfundAddressSet(_crowdfund);
    }

    /// @notice One-time setter: register the TreasurySteward contract.
    /// Deployer-only; locks permanently after the first call.
    function setStewardContract(address _steward) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        if (stewardContractLocked) revert Gov_AlreadyLocked();
        if (_steward == address(0)) revert Gov_ZeroAddress();

        stewardContractLocked = true;
        stewardContract = _steward;

        emit StewardContractSet(_steward);
    }

    // ============ Governance-Updatable Parameters ============

    /// @notice Update proposal type parameters (timing and quorum).
    /// @dev Only callable by the timelock (requires a governance vote). All fields are bounded
    ///      to prevent adversarial parameter changes that could freeze or trivialize governance.
    function setProposalTypeParams(
        ProposalType proposalType,
        ProposalParams calldata params
    ) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        if (proposalType == ProposalType.VetoRatification || proposalType == ProposalType.Steward) revert Gov_ImmutableProposalType();
        if (params.votingDelay < MIN_VOTING_DELAY || params.votingDelay > MAX_VOTING_DELAY) revert Gov_VotingDelayOutOfBounds();
        if (params.votingPeriod < MIN_VOTING_PERIOD || params.votingPeriod > MAX_VOTING_PERIOD) revert Gov_VotingPeriodOutOfBounds();
        if (params.executionDelay < MIN_EXECUTION_DELAY || params.executionDelay > MAX_EXECUTION_DELAY) revert Gov_ExecutionDelayOutOfBounds();
        if (params.quorumBps < MIN_QUORUM_BPS || params.quorumBps > MAX_QUORUM_BPS) revert Gov_QuorumBpsOutOfBounds();

        proposalTypeParams[proposalType] = params;
        emit ProposalTypeParamsUpdated(proposalType, params);
    }

    // ============ Extended Selector Management ============

    /// @notice Register a function selector that forces Extended proposal classification.
    /// @dev Only callable by the timelock (requires an extended governance vote, since
    ///      this selector is itself registered as extended).
    function addExtendedSelector(bytes4 selector) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        if (extendedSelectors[selector]) revert Gov_SelectorAlreadyExtended();

        extendedSelectors[selector] = true;
        emit ExtendedSelectorAdded(selector);
    }

    /// @notice Remove a function selector from the extended classification registry.
    /// @dev Only callable by the timelock (requires an extended governance vote).
    function removeExtendedSelector(bytes4 selector) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        if (!extendedSelectors[selector]) revert Gov_SelectorNotExtended();

        extendedSelectors[selector] = false;
        emit ExtendedSelectorRemoved(selector);
    }

    // ============ Security Council ============

    /// @notice Address of the Security Council multisig. address(0) means ejected/unset.
    address public securityCouncil;

    event SecurityCouncilUpdated(address indexed oldSC, address indexed newSC);

    /// @notice Set or replace the Security Council address. Governance-only (timelock).
    /// Setting to address(0) disables all SC powers (ejection state).
    function setSecurityCouncil(address newSC) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        emit SecurityCouncilUpdated(securityCouncil, newSC);
        securityCouncil = newSC;
    }

    // ============ Veto Mechanism ============

    /// @notice Security Council vetoes a queued proposal, triggering a ratification vote.
    /// @param proposalId The queued proposal to veto
    /// @param rationaleHash Off-chain rationale hash for verifiability
    function veto(uint256 proposalId, bytes32 rationaleHash) external {
        if (msg.sender != securityCouncil) revert Gov_NotSecurityCouncil();
        if (securityCouncil == address(0)) revert Gov_SCEjected();
        if (state(proposalId) != ProposalState.Queued) revert Gov_NotQueued();

        // Double-veto prevention: community denied a veto on identical calldata
        bytes32 calldataHash = _proposalCalldataHash(proposalId);
        if (vetoDeniedHashes[calldataHash]) revert Gov_CommunityOverrodeNoDoubleVeto();

        Proposal storage p = _proposals[proposalId];

        // Cancel the original proposal
        p.canceled = true;

        // Cancel the timelock operation
        bytes32 timelockId = timelock.hashOperationBatch(
            p.targets, p.values, p.calldatas, 0, _proposalSalt(proposalId)
        );
        timelock.cancel(timelockId);

        // Auto-create ratification vote
        uint256 ratId = _createRatificationProposal(proposalId, rationaleHash);

        emit ProposalVetoed(proposalId, rationaleHash, ratId);
    }

    /// @notice Resolve a veto ratification vote after voting ends.
    /// FOR or quorum-not-met = veto upheld. AGAINST with quorum = SC ejected.
    /// @param ratificationId The ratification proposal to resolve
    function resolveRatification(uint256 ratificationId) external {
        uint256 vetoedId = ratificationOf[ratificationId];
        if (vetoedId == 0) revert Gov_NotARatificationProposal();

        Proposal storage p = _proposals[ratificationId];
        if (block.timestamp <= p.voteEnd) revert Gov_VotingNotEnded();
        if (p.executed) revert Gov_AlreadyResolved();

        p.executed = true;

        // Evaluate outcome: does the community uphold or deny the veto?
        bool quorumMet = _quorumReached(ratificationId);
        bool majorityAgainst = quorumMet && (p.againstVotes > p.forVotes);

        if (majorityAgainst) {
            // Community denies the veto → eject SC, store calldata hash
            address oldSC = securityCouncil;
            securityCouncil = address(0);

            vetoDeniedHashes[_proposalCalldataHash(vetoedId)] = true;

            emit SecurityCouncilEjected(ratificationId);
            emit SecurityCouncilUpdated(oldSC, address(0));
            emit RatificationResolved(ratificationId, false);
        } else {
            // FOR wins or quorum not met → veto stands
            emit RatificationResolved(ratificationId, true);
        }
    }

    /// @dev Create a ratification proposal internally (bypasses propose() guards).
    function _createRatificationProposal(
        uint256 vetoedProposalId,
        bytes32 rationaleHash
    ) internal returns (uint256) {
        uint256 ratId = ++proposalCount;

        // Build description for on-chain verifiability
        string memory desc = string(abi.encodePacked(
            "Veto ratification for proposal #",
            GovernorStringLib.uint2str(vetoedProposalId),
            " | rationale: ",
            GovernorStringLib.bytes32ToHex(rationaleHash)
        ));

        _initProposal(ratId, ProposalType.VetoRatification, desc);

        // Ratification has no execution calldata — consequences handled by resolveRatification()
        // (targets, values, calldatas arrays remain empty/default)

        // Store bidirectional mappings
        ratificationOf[ratId] = vetoedProposalId;
        vetoRatificationId[vetoedProposalId] = ratId;

        Proposal storage p = _proposals[ratId];
        emit ProposalCreated(
            ratId, msg.sender, ProposalType.VetoRatification,
            p.voteStart, p.voteEnd, desc
        );

        return ratId;
    }

    /// @dev Compute a deterministic hash of a proposal's calldata for double-veto prevention.
    function _proposalCalldataHash(uint256 proposalId) internal view returns (bytes32) {
        Proposal storage p = _proposals[proposalId];
        return keccak256(abi.encode(p.targets, p.values, p.calldatas));
    }


    // ============ Steward Proposals ============

    /// @notice Create a steward spend proposal (pass-by-default governance proposal).
    /// Only callable by the elected steward via the registered TreasurySteward contract.
    /// The governor constructs stewardSpend calldata internally — the steward cannot
    /// submit arbitrary targets or calldata, only structured spend requests.
    /// @param tokens Token addresses to spend (must be authorized in treasury budget table)
    /// @param recipients Recipient addresses for each spend
    /// @param amounts Amounts to spend for each entry
    /// @param description Human-readable description
    function proposeStewardSpend(
        address[] memory tokens,
        address[] memory recipients,
        uint256[] memory amounts,
        string memory description
    ) external returns (uint256) {
        if (windDownActive) revert Gov_GovernanceEnded();
        if (stewardContract == address(0)) revert Gov_StewardContractNotSet();
        if (msg.sender != ITreasurySteward(stewardContract).currentSteward()) revert Gov_NotCurrentSteward();
        if (!ITreasurySteward(stewardContract).isStewardActive()) revert Gov_StewardNotActive();

        // Auto-resolve all prior steward proposals whose voting has ended.
        // Must run before the pause check: resolution may trigger the circuit breaker.
        _autoResolveStewardProposals();

        if (stewardChannelPaused) revert Gov_StewardChannelPaused();
        if (tokens.length == 0) revert Gov_EmptyProposal();
        if (tokens.length != recipients.length || tokens.length != amounts.length) revert Gov_LengthMismatch();
        _checkQuietPeriod();

        // Self-payment check: steward cannot be a recipient in any spend
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == msg.sender) revert Gov_SelfPaymentNotAllowed();
        }

        // Governor constructs the calldata — steward only provides structured spend params
        address[] memory targets = new address[](tokens.length);
        uint256[] memory values = new uint256[](tokens.length);
        bytes[] memory calldatas = new bytes[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            targets[i] = treasuryAddress;
            calldatas[i] = abi.encodeWithSignature(
                "stewardSpend(address,address,uint256)",
                tokens[i], recipients[i], amounts[i]
            );
        }

        // Defense-in-depth: verify steward calldata would not classify as Extended.
        // Currently safe because stewardSpend is not an extended selector, but this
        // guard protects against future selector additions that could allow sensitive
        // operations to bypass Extended classification via the pass-by-default path.
        if (_classifyProposal(ProposalType.Standard, targets, calldatas) == ProposalType.Extended) revert Gov_StewardCalldataClassifiedAsExtended();

        uint256 proposalId = ++proposalCount;
        _initProposal(proposalId, ProposalType.Steward, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        // No bond required for steward proposals — the steward is an elected role
        // operating within budget limits. Bonds are for standard/extended proposals only.

        // Track for auto-resolution on next proposeStewardSpend() call
        _stewardProposalIds.push(proposalId);

        emit ProposalCreated(
            proposalId, msg.sender, ProposalType.Steward,
            p.voteStart, p.voteEnd, description
        );
        return proposalId;
    }

    /// @notice Resolve a steward proposal's participation for the circuit breaker.
    /// Must be called after the steward proposal's voting period ends. Tracks whether
    /// participation was below 30% and pauses the steward channel if 5 consecutive
    /// proposals fail to meet the threshold.
    /// @param proposalId The steward proposal to resolve
    function resolveStewardProposal(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (!(p.id != 0)) revert Gov_UnknownProposal();
        if (!(p.proposalType == ProposalType.Steward)) revert Gov_NotStewardProposal();
        if (!(block.timestamp > p.voteEnd)) revert Gov_VotingNotEnded();
        if (!(!stewardProposalResolved[proposalId])) revert Gov_AlreadyResolved();
        _resolveStewardProposal(proposalId);
    }

    /// @dev Core resolution logic for a steward proposal. Idempotent — skips already-resolved
    /// proposals. Returns false if voting hasn't ended yet (caller should stop iterating).
    function _resolveStewardProposal(uint256 proposalId) internal returns (bool) {
        Proposal storage p = _proposals[proposalId];
        if (stewardProposalResolved[proposalId]) return true;
        if (block.timestamp <= p.voteEnd) return false;

        stewardProposalResolved[proposalId] = true;

        // Participation = total votes cast / eligible supply at snapshot
        uint256 totalVotesCast = p.forVotes + p.againstVotes + p.abstainVotes;
        uint256 participationBps = p.snapshotEligibleSupply > 0
            ? (totalVotesCast * 10000) / p.snapshotEligibleSupply
            : 0;

        if (participationBps < CIRCUIT_BREAKER_PARTICIPATION_BPS) {
            consecutiveLowParticipationCount++;
            if (consecutiveLowParticipationCount >= CIRCUIT_BREAKER_THRESHOLD) {
                stewardChannelPaused = true;
                emit StewardChannelPaused(proposalId);
            }
        } else {
            consecutiveLowParticipationCount = 0;
        }
        return true;
    }

    /// @dev Auto-resolve all prior steward proposals whose voting period has ended.
    /// Walks from the cursor forward. Because steward proposals are created sequentially
    /// with the same voting period, voteEnd times are monotonically increasing — we can
    /// stop as soon as one hasn't ended yet.
    function _autoResolveStewardProposals() internal {
        uint256 len = _stewardProposalIds.length;
        uint256 i = _stewardResolveIndex;
        while (i < len) {
            if (!_resolveStewardProposal(_stewardProposalIds[i])) break;
            i++;
        }
        _stewardResolveIndex = i;
    }

    /// @notice Resume the steward channel after a circuit breaker pause.
    /// Standard proposal (20% quorum, 7-day voting) per governance spec §Circuit breaker.
    function resumeStewardChannel() external {
        if (!(msg.sender == address(timelock))) revert Gov_NotTimelock();
        if (!(stewardChannelPaused)) revert Gov_NotPaused();

        stewardChannelPaused = false;
        consecutiveLowParticipationCount = 0;

        emit StewardChannelResumed();
    }

    // ============ Wind-Down ============

    /// @notice One-time setter: register the wind-down contract address.
    /// Callable by timelock (governance) since the wind-down contract may be deployed
    /// after the governor and needs a governance-approved registration.
    function setWindDownContract(address _windDownContract) external {
        if (!(msg.sender == address(timelock))) revert Gov_NotTimelock();
        if (!(!windDownContractSet)) revert Gov_WindDownContractAlreadySet();
        if (!(_windDownContract != address(0))) revert Gov_ZeroAddress();

        windDownContractSet = true;
        windDownContract = _windDownContract;

        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Called by the wind-down contract to permanently disable governance.
    /// Once active, no new proposals can be created. Existing proposals in flight
    /// (Active, Succeeded, Queued) can still complete their lifecycle.
    function setWindDownActive() external {
        if (!(msg.sender == windDownContract)) revert Gov_NotWindDownContract();
        if (!(windDownContract != address(0))) revert Gov_WindDownContractNotSet();
        if (!(!windDownActive)) revert Gov_WindDownAlreadyActive();

        windDownActive = true;

        emit WindDownActivated();
    }

    // ============ Adapter Registry Management ============

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
        if (!(!windDownActive)) revert Gov_GovernanceEnded();
        if (!(targets.length > 0)) revert Gov_EmptyProposal();
        if (!(targets.length == values.length && targets.length == calldatas.length)) revert Gov_LengthMismatch();
        if (!(proposalType != ProposalType.VetoRatification && proposalType != ProposalType.Steward)) revert Gov_AutoCreatedOnly();
        _checkQuietPeriod();
        _checkProposalThreshold(msg.sender);

        // Mechanical classification: if any calldata triggers extended, override to Extended.
        // Proposers can opt into Extended voluntarily, but cannot downgrade to Standard
        // when calldata contains extended-classified function calls.
        ProposalType effectiveType = _classifyProposal(proposalType, targets, calldatas);

        uint256 proposalId = ++proposalCount;
        _initProposal(proposalId, effectiveType, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        // Bond: required only when ARM is transferable (post-transfer-unlock).
        // Pre-transfer-unlock, bonds are economically meaningless and technically impossible
        // for non-whitelisted holders, so governance operates on threshold only.
        if (armToken.transferable()) {
            if (!(armToken.transferFrom(msg.sender, address(this), PROPOSAL_BOND))) revert Gov_BondTransferFailed();
            proposalBonds[proposalId] = BondInfo({
                depositor: msg.sender,
                amount: PROPOSAL_BOND,
                unlockTime: 0,
                claimed: false
            });
            emit BondPosted(proposalId, msg.sender, PROPOSAL_BOND);
        }

        emit ProposalCreated(
            proposalId, msg.sender, effectiveType,
            p.voteStart, p.voteEnd, description
        );
        return proposalId;
    }

    /// @dev Check that proposer has enough delegated voting power (0.1% of total supply)
    function _checkProposalThreshold(address proposer) internal view {
        uint256 proposerVotes = armToken.getPastVotes(proposer, block.number - 1);
        uint256 threshold = (armToken.totalSupply() * PROPOSAL_THRESHOLD_BPS) / 10000;
        if (!(proposerVotes >= threshold)) revert Gov_BelowProposalThreshold();
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

        // Snapshot eligible supply and quorumBps so quorum is fixed at proposal creation.
        // Excluded addresses (treasury, crowdfund, etc.) are subtracted from total supply
        // so that undelegated/non-voting tokens don't inflate the quorum denominator.
        //
        // Known property: totalSupply is historical (getPastTotalSupply at snapshot block),
        // but excluded balances use current balanceOf(). ERC20Votes has no getPastBalanceOf —
        // only getPastVotes (delegated power), which returns 0 for undelegated excluded
        // addresses. Since snapshotBlock = block.number - 1, the drift window is exactly
        // one block. Treasury and crowdfund balances change only via governance actions,
        // so the practical impact is negligible.
        p.snapshotQuorumBps = params.quorumBps;
        uint256 totalSupply = armToken.getPastTotalSupply(p.snapshotBlock);
        uint256 excludedBalance = armToken.balanceOf(treasuryAddress);
        for (uint256 i = 0; i < _excludedFromQuorum.length; i++) {
            excludedBalance += armToken.balanceOf(_excludedFromQuorum[i]);
        }
        // Cap excludedBalance to prevent underflow if tokens moved into excluded
        // addresses between the snapshot block and now.
        if (excludedBalance > totalSupply) {
            excludedBalance = totalSupply;
        }
        p.snapshotEligibleSupply = totalSupply - excludedBalance;
    }

    /// @notice Cast or change a vote on a proposal.
    /// @dev Voters can switch between FOR, AGAINST, and ABSTAIN during voting.
    ///      Votes cannot be withdrawn entirely — once cast, the voter's weight counts toward
    ///      quorum permanently. Total participation (forVotes + againstVotes + abstainVotes) is
    ///      monotonically non-decreasing because switching only moves weight between buckets.
    /// @param proposalId Proposal to vote on
    /// @param support 0=Against, 1=For, 2=Abstain
    function castVote(uint256 proposalId, uint8 support) external {
        Proposal storage p = _proposals[proposalId];
        if (!(p.id != 0)) revert Gov_UnknownProposal();
        if (!(block.timestamp >= p.voteStart)) revert Gov_VotingNotStarted();
        if (!(block.timestamp <= p.voteEnd)) revert Gov_VotingEnded();
        if (!(support <= 2)) revert Gov_InvalidVoteType();

        uint256 weight = armToken.getPastVotes(msg.sender, p.snapshotBlock);
        if (!(weight > 0)) revert Gov_NoVotingPower();

        if (hasVoted[proposalId][msg.sender]) {
            // Vote change: subtract from old bucket, add to new bucket
            uint8 oldSupport = voteChoice[proposalId][msg.sender];
            if (!(oldSupport != support)) revert Gov_SameVote();

            if (oldSupport == 0) {
                p.againstVotes -= weight;
            } else if (oldSupport == 1) {
                p.forVotes -= weight;
            } else {
                p.abstainVotes -= weight;
            }

            if (support == 0) {
                p.againstVotes += weight;
            } else if (support == 1) {
                p.forVotes += weight;
            } else {
                p.abstainVotes += weight;
            }

            voteChoice[proposalId][msg.sender] = support;
            emit VoteChanged(msg.sender, proposalId, oldSupport, support, weight);
        } else {
            // First vote
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
    }

    /// @notice Queue a succeeded proposal to the timelock
    function queue(uint256 proposalId) external {
        if (!(state(proposalId) == ProposalState.Succeeded)) revert Gov_NotSucceeded();

        Proposal storage p = _proposals[proposalId];
        if (!(p.proposalType != ProposalType.VetoRatification)) revert Gov_UseResolveRatification();
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
        if (!(state(proposalId) == ProposalState.Queued)) revert Gov_NotQueued();

        Proposal storage p = _proposals[proposalId];
        if (!(p.proposalType != ProposalType.VetoRatification)) revert Gov_UseResolveRatification();
        p.executed = true;

        timelock.executeBatch{value: msg.value}(
            p.targets, p.values, p.calldatas,
            0, // no predecessor
            _proposalSalt(proposalId)
        );

        emit ProposalExecuted(proposalId);
    }

    /// @notice Cancel a proposal. Standard/Extended: proposer only, while Pending.
    /// Steward proposals: proposer only, while Pending or Active (steward proposals
    /// skip Pending due to zero voting delay, so Active is the earliest cancellable state).
    function cancel(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (!(p.id != 0)) revert Gov_UnknownProposal();
        if (!(msg.sender == p.proposer)) revert Gov_NotProposer();

        ProposalState currentState = state(proposalId);
        if (p.proposalType == ProposalType.Steward) {
            if (!(currentState == ProposalState.Pending || currentState == ProposalState.Active)) revert Gov_NotPendingOrActive();
        } else {
            if (!(currentState == ProposalState.Pending)) revert Gov_NotPending();
        }

        p.canceled = true;

        emit ProposalCanceled(proposalId);
    }

    /// @notice Claim a proposal bond after the lock period has elapsed.
    /// Bond is always returned — lock periods vary by defeat reason.
    function claimBond(uint256 proposalId) external nonReentrant {
        BondInfo storage bond = proposalBonds[proposalId];
        if (!(bond.amount > 0)) revert Gov_NoBond();
        if (!(!bond.claimed)) revert Gov_BondAlreadyClaimed();

        ProposalState currentState = state(proposalId);
        Proposal storage p = _proposals[proposalId];

        uint256 unlockTime;

        if (currentState == ProposalState.Executed) {
            // Passed and executed: immediately claimable
            unlockTime = 0;
        } else if (currentState == ProposalState.Canceled) {
            uint256 ratId = vetoRatificationId[proposalId];
            if (ratId != 0) {
                // Vetoed proposal: bond deferred until ratification resolves.
                // Proposer did nothing wrong — proposal passed on merit — so no penalty.
                Proposal storage rat = _proposals[ratId];
                if (!(rat.executed)) revert Gov_RatificationNotResolved();
                unlockTime = 0;
            } else {
                // Proposer self-cancelled during Pending: immediately claimable
                unlockTime = 0;
            }
        } else if (currentState == ProposalState.Defeated) {
            // Determine defeat reason to set appropriate bond lock period
            bool quorumMet = _quorumReached(proposalId);
            bool votePassed = _voteSucceeded(proposalId);
            if (quorumMet && votePassed) {
                // Vote passed but proposal expired (grace period elapsed without queuing).
                // Proposer did nothing wrong — treat like a passed proposal.
                unlockTime = 0;
            } else if (!quorumMet) {
                unlockTime = p.voteEnd + BOND_LOCK_QUORUM_FAIL;
            } else {
                // Quorum met but majority voted against
                unlockTime = p.voteEnd + BOND_LOCK_VOTE_FAIL;
            }
        } else {
            revert Gov_ProposalNotInTerminalState();
        }

        if (!(block.timestamp >= unlockTime)) revert Gov_BondStillLocked();

        bond.claimed = true;
        if (!(armToken.transfer(bond.depositor, bond.amount))) revert Gov_BondReturnFailed();

        emit BondClaimed(proposalId, bond.depositor, bond.amount);
    }

    // ============ View Functions ============

    /// @notice Get current state of a proposal
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (!(p.id != 0)) revert Gov_UnknownProposal();

        if (p.canceled) return ProposalState.Canceled;
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp < p.voteStart) return ProposalState.Pending;
        if (block.timestamp <= p.voteEnd) return ProposalState.Active;

        // After voting ends: check quorum and majority
        if (p.proposalType == ProposalType.Steward) {
            // Pass-by-default: defeated ONLY if quorum met AND strict majority votes against
            if (_quorumReached(proposalId) && p.againstVotes > p.forVotes) {
                return ProposalState.Defeated;
            }
        } else {
            if (!_quorumReached(proposalId) || !_voteSucceeded(proposalId)) {
                return ProposalState.Defeated;
            }
        }

        if (p.queued) return ProposalState.Queued;

        // Succeeded proposals expire if not queued within the grace period
        if (block.timestamp > p.voteEnd + QUEUE_GRACE_PERIOD) {
            return ProposalState.Defeated;
        }

        return ProposalState.Succeeded;
    }

    /// @notice Calculate quorum for a proposal: max(X% of eligible supply, absolute floor).
    /// Both eligible supply and quorumBps are frozen at proposal creation so quorum cannot
    /// shift during voting — even if governance updates params mid-flight.
    /// The absolute floor (QUORUM_FLOOR) prevents governance from passing on near-zero turnout
    /// when circulating delegated supply is small (e.g. early in the protocol lifecycle).
    function quorum(uint256 proposalId) public view returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        uint256 percentageQuorum = (p.snapshotEligibleSupply * p.snapshotQuorumBps) / 10000;
        return percentageQuorum > QUORUM_FLOOR ? percentageQuorum : QUORUM_FLOOR;
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
        uint256 snapshotBlock,
        uint256 snapshotEligibleSupply
    ) {
        Proposal storage p = _proposals[proposalId];
        return (
            p.proposer, p.proposalType, p.voteStart, p.voteEnd,
            p.forVotes, p.againstVotes, p.abstainVotes, p.snapshotBlock,
            p.snapshotEligibleSupply
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
        // Quorum measures total participation — all vote types count
        return (p.forVotes + p.againstVotes + p.abstainVotes) >= quorum(proposalId);
    }

    function _voteSucceeded(uint256 proposalId) internal view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.forVotes > p.againstVotes;
    }

    /// @dev Unique salt per proposal for timelock deduplication
    function _proposalSalt(uint256 proposalId) internal pure returns (bytes32) {
        return bytes32(proposalId);
    }

    /// @dev Classify a proposal based on its calldata. If any action targets a function
    ///      in the extended selector registry, force Extended. If a distribute() call would
    ///      move >5% of the treasury's balance of that token, force Extended.
    ///      The proposer's declared type is respected only if it's already Extended.
    function _classifyProposal(
        ProposalType declaredType,
        address[] memory, /* targets — reserved for future target-specific checks */
        bytes[] memory calldatas
    ) internal view returns (ProposalType) {
        // If already Extended, no need to check further
        if (declaredType == ProposalType.Extended) return ProposalType.Extended;

        for (uint256 i = 0; i < calldatas.length; i++) {
            if (calldatas[i].length < 4) continue;

            bytes4 selector;
            // solhint-disable-next-line no-inline-assembly
            assembly {
                // calldatas[i] is a bytes memory; its data starts at offset 0x20
                let dataPtr := mload(add(add(calldatas, 0x20), mul(i, 0x20)))
                selector := mload(add(dataPtr, 0x20))
            }

            // Check registered extended selectors
            if (extendedSelectors[selector]) return ProposalType.Extended;

            // Special case: distribute() calls exceeding 5% of treasury balance
            if (selector == DISTRIBUTE_SELECTOR && calldatas[i].length >= 100) {
                // Decode: distribute(address token, address recipient, uint256 amount)
                // token is at bytes 4..35, amount is at bytes 68..99
                address token;
                uint256 amount;
                // solhint-disable-next-line no-inline-assembly
                assembly {
                    let dataPtr := mload(add(add(calldatas, 0x20), mul(i, 0x20)))
                    token := mload(add(dataPtr, 0x24))  // skip 4-byte selector + 32 bytes but token is at offset 4
                    amount := mload(add(dataPtr, 0x64)) // offset 4 + 32 + 32 = 68
                }
                uint256 treasuryBalance = IERC20(token).balanceOf(treasuryAddress);
                if (treasuryBalance > 0 && amount > (treasuryBalance * TREASURY_EXTENDED_THRESHOLD_BPS) / 10000) {
                    return ProposalType.Extended;
                }
            }
        }

        return declaredType;
    }

    /// @dev Block proposals during the quiet period after crowdfund finalization.
    ///      Reads finalizedAt from the crowdfund contract. Skips gracefully if no
    ///      crowdfund is registered or crowdfund isn't finalized.
    function _checkQuietPeriod() internal view {
        if (crowdfundAddress == address(0)) return;

        uint256 _finalizedAt = IArmadaCrowdfundReadable(crowdfundAddress).finalizedAt();
        if (_finalizedAt == 0) return;

        if (!(block.timestamp >= _finalizedAt + QUIET_PERIOD_DURATION)) revert Gov_QuietPeriodActive();
    }

    // ============ UUPS ============

    /// @dev Only the timelock (governance) can authorize upgrades.
    ///      The upgradeTo/upgradeToAndCall selectors are registered as extended selectors,
    ///      so upgrade proposals automatically require Extended-type quorum and timing.
    function _authorizeUpgrade(address) internal override {
        if (!(msg.sender == address(timelock))) revert Gov_NotTimelock();
    }

    // ============ Storage Gap ============

    /// @dev Reserved storage for future upgrades. 25 state slots + 25 gap = 50 total.
    uint256[25] private __gap;
}
