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
    error Gov_AlreadyLocked();
    error Gov_AlreadyResolved();
    error Gov_AutoCreatedOnly();
    error Gov_BelowProposalThreshold();
    error Gov_CommunityOverrodeNoDoubleVeto();
    error Gov_EmptyProposal();
    error Gov_ExecutionDelayOutOfBounds();
    error Gov_GovernanceEnded();
    error Gov_ImmutableProposalType();
    error Gov_InvalidVoteType();
    error Gov_LengthMismatch();
    error Gov_NoVotingPower();
    error Gov_NotARatificationProposal();
    error Gov_NotCurrentSteward();
    error Gov_NotPendingOrActive();
    error Gov_NotPending();
    error Gov_NotProposer();
    error Gov_NotQueued();
    error Gov_NotSecurityCouncil();
    error Gov_NotSucceeded();
    error Gov_NotTimelock();
    error Gov_NotWindDownContract();
    error Gov_ProposalCanceled();
    error Gov_QuietPeriodActive();
    error Gov_QuorumBpsOutOfBounds();
    error Gov_SameVote();
    error Gov_SelectorAlreadyExtended();
    error Gov_SelectorNotExtended();
    error Gov_SelfPaymentNotAllowed();
    error Gov_StewardCalldataClassifiedAsExtended();
    error Gov_StewardContractNotSet();
    error Gov_StewardNotActive();
    error Gov_StewardProposerNoLongerActive();
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
    error Gov_TreasuryAlreadyExcluded();

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
    // Initial set is hardcoded in initialize(); governance can modify via addExtendedSelector/removeExtendedSelector.
    mapping(bytes4 => bool) public extendedSelectors;

    // Treasury >5% threshold for automatic extended classification of distribute() calls.
    // The distribute selector is checked specially: if amount > 5% of treasury balance, Extended.
    bytes4 public constant DISTRIBUTE_SELECTOR = bytes4(keccak256("distribute(address,address,uint256)"));
    uint256 public constant TREASURY_EXTENDED_THRESHOLD_BPS = 500; // 5%

    // Fail-closed classification: selectors not in extendedSelectors AND not in
    // standardSelectors default to Extended. This prevents bypass via unclassified
    // selectors (e.g. wrapper/forwarder contracts, newly added protocol functions).
    mapping(bytes4 => bool) public standardSelectors;

    // ============ Veto & Ratification ============

    /// @notice Calldata hashes of proposals where community denied the SC's veto.
    /// Prevents the SC from vetoing identical proposal content twice.
    mapping(bytes32 => bool) public vetoDeniedHashes;

    /// @notice Maps ratification proposalId → original vetoed proposalId
    mapping(uint256 => uint256) public ratificationOf;

    /// @notice Maps vetoed proposalId → ratification proposalId (reverse lookup)
    mapping(uint256 => uint256) public vetoRatificationId;

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
    event StandardSelectorAdded(bytes4 indexed selector);
    event StandardSelectorRemoved(bytes4 indexed selector);
    event StewardContractSet(address indexed steward);
    event ProposalVetoed(uint256 indexed proposalId, bytes32 rationaleHash, uint256 ratificationId);
    event RatificationResolved(uint256 indexed ratificationId, bool vetoUpheld);
    event SecurityCouncilEjected(uint256 indexed ratificationId);
    event ExcludedAddressesSet(address[] addresses);
    event DeployerCleared(address indexed previousDeployer);

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

        // Hardcoded extended selectors per governance spec §Scope table.
        // These cannot be misconfigured at deployment. Governance can expand or
        // shrink this set at any time via addExtendedSelector/removeExtendedSelector.

        // Governance parameter changes (on ArmadaGovernor)
        extendedSelectors[this.addExtendedSelector.selector] = true;
        extendedSelectors[this.removeExtendedSelector.selector] = true;
        extendedSelectors[this.addStandardSelector.selector] = true;
        extendedSelectors[this.removeStandardSelector.selector] = true;
        extendedSelectors[this.setSecurityCouncil.selector] = true;
        extendedSelectors[this.setProposalTypeParams.selector] = true;
        extendedSelectors[this.setWindDownContract.selector] = true;
        // UUPS upgrade selectors
        extendedSelectors[bytes4(keccak256("upgradeTo(address)"))] = true;
        extendedSelectors[bytes4(keccak256("upgradeToAndCall(address,bytes)"))] = true;
        // Fee parameters (on privacy pool and yield vault)
        extendedSelectors[bytes4(keccak256("setShieldFee(uint120)"))] = true;
        extendedSelectors[bytes4(keccak256("setUnshieldFee(uint120)"))] = true;
        extendedSelectors[bytes4(keccak256("setYieldFeeBps(uint256)"))] = true;
        // Steward election (on TreasurySteward) — removal is Standard (defensive/emergency action)
        extendedSelectors[bytes4(keccak256("electSteward(address)"))] = true;
        // ARM token transfer whitelist
        extendedSelectors[bytes4(keccak256("addToWhitelist(address)"))] = true;
        // Revenue definition expansion (on RevenueCounter)
        extendedSelectors[bytes4(keccak256("setFeeCollector(address)"))] = true;
        // ArmadaFeeModule — fee parameters (per governance spec: all fee changes → Extended)
        extendedSelectors[bytes4(keccak256("setBaseArmadaTake(uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("addTier(uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setTier(uint256,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("removeTier(uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setYieldFee(uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setIntegratorTerms(address,uint256,uint256,bool)"))] = true;
        // Steward budget token management (on ArmadaTreasuryGov)
        extendedSelectors[bytes4(keccak256("addStewardBudgetToken(address,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("updateStewardBudgetToken(address,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("removeStewardBudgetToken(address)"))] = true;
        // Treasury outflow limit parameters
        extendedSelectors[bytes4(keccak256("setOutflowWindow(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitBps(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitAbsolute(address,uint256)"))] = true;
        // Adapter lifecycle (on AdapterRegistry) — affects which contracts interact with shielded yield
        extendedSelectors[bytes4(keccak256("authorizeAdapter(address)"))] = true;
        extendedSelectors[bytes4(keccak256("deauthorizeAdapter(address)"))] = true;
        extendedSelectors[bytes4(keccak256("fullDeauthorizeAdapter(address)"))] = true;
        // Wind-down parameter adjustments (on ArmadaWindDown) — high-impact, can extend protocol lifetime
        extendedSelectors[bytes4(keccak256("setRevenueThreshold(uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setWindDownDeadline(uint256)"))] = true;
        // Wrapper/forwarder deny-list — force Extended for generic relay patterns that could
        // wrap an Extended action inside a Standard-looking call. Defense-in-depth alongside
        // the fail-closed default.
        extendedSelectors[bytes4(keccak256("callContract(address,bytes,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("functionCall(address,bytes)"))] = true;
        extendedSelectors[bytes4(keccak256("functionCallWithValue(address,bytes,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("functionDelegateCall(address,bytes)"))] = true;
        extendedSelectors[bytes4(keccak256("multicall(bytes[])"))] = true;
        extendedSelectors[bytes4(keccak256("execute(bytes)"))] = true;
        extendedSelectors[bytes4(keccak256("execute(address,bytes)"))] = true;

        // Fail-closed default: selectors explicitly permitted at Standard classification.
        // Any selector NOT in extendedSelectors AND NOT in standardSelectors defaults to Extended.
        standardSelectors[DISTRIBUTE_SELECTOR] = true;  // distribute() below the 5% threshold
        standardSelectors[bytes4(keccak256("stewardSpend(address,address,uint256)"))] = true;
        standardSelectors[bytes4(keccak256("transferTo(address,address,uint256)"))] = true;
        standardSelectors[bytes4(keccak256("transferETHTo(address,uint256)"))] = true;
        // ARM token transfer enable — one-way, irreversible, callable via governance or wind-down
        standardSelectors[bytes4(keccak256("setTransferable(bool)"))] = true;
        // Steward removal — defensive/emergency action, lower bar per spec
        standardSelectors[bytes4(keccak256("removeSteward()"))] = true;
        // Permissionless crowdfund sweep — anyone can call directly, governance path is optional
        standardSelectors[bytes4(keccak256("withdrawUnallocatedArm()"))] = true;
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
            if (addrs[i] == treasuryAddress) revert Gov_TreasuryAlreadyExcluded();
            _excludedFromQuorum.push(addrs[i]);
        }

        emit ExcludedAddressesSet(addrs);
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

    /// @notice Clear the deployer address after all one-time setters have been called.
    /// Deployer-only. Eliminates the deployer as a privileged address in upgradeable storage,
    /// preventing future UUPS upgrades from inheriting deployer-gated privileges.
    function clearDeployer() external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        address previousDeployer = deployer;
        deployer = address(0);

        emit DeployerCleared(previousDeployer);
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

    /// @notice Add a function selector to the standard classification registry.
    /// @dev Only callable by the timelock. Required when adding new protocol functions
    ///      that should pass at Standard quorum. Without this, new selectors default to Extended.
    function addStandardSelector(bytes4 selector) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        standardSelectors[selector] = true;
        emit StandardSelectorAdded(selector);
    }

    /// @notice Remove a function selector from the standard classification registry.
    /// @dev Only callable by the timelock. After removal, the selector defaults to Extended.
    function removeStandardSelector(bytes4 selector) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        standardSelectors[selector] = false;
        emit StandardSelectorRemoved(selector);
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

        // Description is generic; vetoedProposalId and rationaleHash are queryable
        // on-chain via ratificationOf() mapping and ProposalVetoed event.
        string memory desc = "Veto ratification";

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

        emit ProposalCreated(
            proposalId, msg.sender, ProposalType.Steward,
            p.voteStart, p.voteEnd, description
        );
        return proposalId;
    }

    // ============ Wind-Down ============

    /// @notice One-time setter: register the wind-down contract address.
    /// Callable by timelock (governance) since the wind-down contract may be deployed
    /// after the governor and needs a governance-approved registration.
    function setWindDownContract(address _windDownContract) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        if (windDownContractSet) revert Gov_WindDownContractAlreadySet();
        if (_windDownContract == address(0)) revert Gov_ZeroAddress();

        windDownContractSet = true;
        windDownContract = _windDownContract;

        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Called by the wind-down contract to permanently disable governance.
    /// Once active, no new proposals can be created. Existing proposals in flight
    /// (Active, Succeeded, Queued) can still complete their lifecycle.
    function setWindDownActive() external {
        if (msg.sender != windDownContract) revert Gov_NotWindDownContract();
        if (windDownContract == address(0)) revert Gov_WindDownContractNotSet();
        if (windDownActive) revert Gov_WindDownAlreadyActive();

        windDownActive = true;

        emit WindDownActivated();
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
        if (windDownActive) revert Gov_GovernanceEnded();
        if (targets.length == 0) revert Gov_EmptyProposal();
        if (targets.length != values.length || targets.length != calldatas.length) revert Gov_LengthMismatch();
        if (proposalType == ProposalType.VetoRatification || proposalType == ProposalType.Steward) revert Gov_AutoCreatedOnly();
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
        if (proposerVotes < threshold) revert Gov_BelowProposalThreshold();
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
        uint256 excludedLen = _excludedFromQuorum.length;
        for (uint256 i = 0; i < excludedLen; i++) {
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
        if (p.id == 0) revert Gov_UnknownProposal();
        if (p.canceled) revert Gov_ProposalCanceled();
        if (block.timestamp < p.voteStart) revert Gov_VotingNotStarted();
        if (block.timestamp > p.voteEnd) revert Gov_VotingEnded();
        if (support > 2) revert Gov_InvalidVoteType();

        uint256 weight = armToken.getPastVotes(msg.sender, p.snapshotBlock);
        if (weight == 0) revert Gov_NoVotingPower();

        if (hasVoted[proposalId][msg.sender]) {
            // Vote change: subtract from old bucket, add to new bucket
            uint8 oldSupport = voteChoice[proposalId][msg.sender];
            if (oldSupport == support) revert Gov_SameVote();
            _removeVoteBucket(p, oldSupport, weight);
            _addVoteBucket(p, support, weight);
            voteChoice[proposalId][msg.sender] = support;
            emit VoteChanged(msg.sender, proposalId, oldSupport, support, weight);
        } else {
            hasVoted[proposalId][msg.sender] = true;
            voteChoice[proposalId][msg.sender] = support;
            _addVoteBucket(p, support, weight);
            emit VoteCast(msg.sender, proposalId, support, weight);
        }
    }

    /// @notice Queue a succeeded proposal to the timelock
    function queue(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Succeeded) revert Gov_NotSucceeded();

        Proposal storage p = _proposals[proposalId];
        if (p.proposalType == ProposalType.VetoRatification) revert Gov_UseResolveRatification();

        // Steward proposals must not be queueable after steward removal or term expiry.
        // Creation-time checks in proposeStewardSpend() verify steward status at proposal
        // time, but a steward can be removed while their proposal is still in voting.
        if (p.proposalType == ProposalType.Steward) {
            if (stewardContract == address(0)
                || p.proposer != ITreasurySteward(stewardContract).currentSteward()
                || !ITreasurySteward(stewardContract).isStewardActive()) {
                revert Gov_StewardProposerNoLongerActive();
            }
        }

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
        if (state(proposalId) != ProposalState.Queued) revert Gov_NotQueued();

        Proposal storage p = _proposals[proposalId];
        if (p.proposalType == ProposalType.VetoRatification) revert Gov_UseResolveRatification();

        // Mirror the queue()-time steward check: a steward removed or expired during the
        // execution delay must not have their proposal execute. Without this, the SC veto
        // would be the only backstop for the term-expiry edge case.
        if (p.proposalType == ProposalType.Steward) {
            if (stewardContract == address(0)
                || p.proposer != ITreasurySteward(stewardContract).currentSteward()
                || !ITreasurySteward(stewardContract).isStewardActive()) {
                revert Gov_StewardProposerNoLongerActive();
            }
        }

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
        if (p.id == 0) revert Gov_UnknownProposal();
        if (msg.sender != p.proposer) revert Gov_NotProposer();

        ProposalState currentState = state(proposalId);
        if (p.proposalType == ProposalType.Steward) {
            if (currentState != ProposalState.Pending && currentState != ProposalState.Active) revert Gov_NotPendingOrActive();
        } else {
            if (currentState != ProposalState.Pending) revert Gov_NotPending();
        }

        p.canceled = true;

        emit ProposalCanceled(proposalId);
    }

    // ============ View Functions ============

    /// @notice Get current state of a proposal
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) revert Gov_UnknownProposal();

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

    /// @dev Add voting weight to the appropriate tally bucket.
    function _addVoteBucket(Proposal storage p, uint8 support, uint256 weight) internal {
        if (support == 0) {
            p.againstVotes += weight;
        } else if (support == 1) {
            p.forVotes += weight;
        } else {
            p.abstainVotes += weight;
        }
    }

    /// @dev Remove voting weight from the appropriate tally bucket.
    function _removeVoteBucket(Proposal storage p, uint8 support, uint256 weight) internal {
        if (support == 0) {
            p.againstVotes -= weight;
        } else if (support == 1) {
            p.forVotes -= weight;
        } else {
            p.abstainVotes -= weight;
        }
    }

    function _voteSucceeded(uint256 proposalId) internal view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.forVotes > p.againstVotes;
    }

    /// @dev Unique salt per proposal for timelock deduplication
    function _proposalSalt(uint256 proposalId) internal pure returns (bytes32) {
        return bytes32(proposalId);
    }

    /// @dev Classify a proposal based on its calldata. Fail-closed: any selector not
    ///      explicitly registered as Extended or Standard defaults to Extended.
    ///      If any action targets an extended selector, the entire proposal is Extended.
    ///      If a distribute() call would move >5% of treasury balance, force Extended.
    function _classifyProposal(
        ProposalType declaredType,
        address[] memory, /* targets — reserved for future target-specific checks */
        bytes[] memory calldatas
    ) internal view returns (ProposalType) {
        // If already Extended, no need to check further
        if (declaredType == ProposalType.Extended) return ProposalType.Extended;

        for (uint256 i = 0; i < calldatas.length; i++) {
            if (calldatas[i].length < 4) continue;

            bytes4 selector = bytes4(calldatas[i]);

            // Check registered extended selectors
            if (extendedSelectors[selector]) return ProposalType.Extended;

            // Special case: distribute() calls exceeding 5% of treasury balance.
            // DESIGN NOTE: This uses a spot balanceOf() check. An attacker could inflate the
            // treasury balance (by donating tokens) to make a large distribution appear to be
            // below the 5% threshold. This is accepted because: (1) donated tokens are lost to
            // the attacker, making the attack economically irrational, (2) USDC lacks
            // checkpointing so snapshot-based alternatives are not available, and (3) the
            // Security Council can veto any suspicious proposal regardless of classification.
            if (selector == DISTRIBUTE_SELECTOR && calldatas[i].length >= 100) {
                // Decode: distribute(address token, address recipient, uint256 amount)
                // Skip the 4-byte selector by slicing from index 4 onward
                bytes memory params = new bytes(calldatas[i].length - 4);
                for (uint256 j = 0; j < params.length; j++) {
                    params[j] = calldatas[i][j + 4];
                }
                (address token, , uint256 amount) = abi.decode(params, (address, address, uint256));
                uint256 treasuryBalance = IERC20(token).balanceOf(treasuryAddress);
                if (treasuryBalance > 0 && amount > (treasuryBalance * TREASURY_EXTENDED_THRESHOLD_BPS) / 10000) {
                    return ProposalType.Extended;
                }
            }

            // Fail-closed: unrecognized selectors force Extended classification.
            // This prevents bypass via wrapper/forwarder contracts or newly added
            // protocol functions that haven't been classified yet.
            if (!standardSelectors[selector]) return ProposalType.Extended;
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

        if (block.timestamp < _finalizedAt + QUIET_PERIOD_DURATION) revert Gov_QuietPeriodActive();
    }

    // ============ UUPS ============

    /// @dev Only the timelock (governance) can authorize upgrades.
    ///      The upgradeTo/upgradeToAndCall selectors are registered as extended selectors,
    ///      so upgrade proposals automatically require Extended-type quorum and timing.
    function _authorizeUpgrade(address) internal override {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
    }

    // ============ Storage Gap ============

    /// @dev Reserved storage for future upgrades. 25 state slots + 25 gap = 50 total.
    uint256[25] private __gap;
}
