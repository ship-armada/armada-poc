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
import "./EmergencyPausableUpgradeable.sol";
import "../crowdfund/IArmadaCrowdfund.sol";

/// @title ArmadaGovernor — UUPS-upgradeable governance with typed proposals and ERC20Votes delegation
/// @notice Implements the Armada governance spec: proposal lifecycle, per-type quorum/timing,
///         voting via delegated ARM tokens, and timelock execution. Upgradeable via UUPS,
///         gated by the timelock (requires extended governance proposal).
contract ArmadaGovernor is Initializable, ReentrancyGuardUpgradeable, UUPSUpgradeable, EmergencyPausableUpgradeable {

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
    // One-time bootstrapping measure; governable (can be shortened or removed).
    address public crowdfundAddress;
    bool public crowdfundAddressLocked;
    uint256 public quietPeriodDuration;
    uint256 public constant MAX_QUIET_PERIOD = 30 days;

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

    // ============ Adapter Registry ============

    /// @notice Fully authorized adapters can perform all operations (deposit + withdraw).
    mapping(address => bool) public authorizedAdapters;

    /// @notice Deauthorized adapters in withdraw-only mode (users can exit positions).
    mapping(address => bool) public withdrawOnlyAdapters;

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
    event QuietPeriodUpdated(uint256 newDuration);
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
    event AdapterAuthorized(address indexed adapter);
    event AdapterDeauthorized(address indexed adapter);
    event AdapterFullyDeauthorized(address indexed adapter);
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
    /// @param _guardian Emergency pause guardian address
    /// @param _maxPauseDuration Maximum pause duration in seconds
    function initialize(
        address _armToken,
        address payable _timelock,
        address _treasuryAddress,
        address _guardian,
        uint256 _maxPauseDuration
    ) external initializer {
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __EmergencyPausable_init(_guardian, _maxPauseDuration, _timelock);

        require(_armToken != address(0), "ArmadaGovernor: zero armToken");
        require(_timelock != address(0), "ArmadaGovernor: zero timelock");
        require(_treasuryAddress != address(0), "ArmadaGovernor: zero treasury");
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
        // Pass-by-default: passes unless quorum met AND majority votes AGAINST.
        // These params bypass setProposalTypeParams() bounds, making Steward timing
        // effectively immutable via governance. Only proposeStewardSpend() creates these.
        proposalTypeParams[ProposalType.Steward] = ProposalParams({
            votingDelay: 0,
            votingPeriod: 7 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

        // Governance quiet period: 7 days post-crowdfund-finalization before proposals allowed
        quietPeriodDuration = 7 days;

        // Register function selectors that force Extended classification.
        // Any proposal containing a call to one of these selectors is automatically Extended
        // regardless of what the proposer declared.
        _registerExtendedSelectors();
    }

    /// @dev Register initial extended selectors. Separated from constructor for readability.
    function _registerExtendedSelectors() internal {
        // Governance parameter changes
        extendedSelectors[this.setProposalTypeParams.selector] = true;
        extendedSelectors[this.setWindDownContract.selector] = true;
        extendedSelectors[this.addExtendedSelector.selector] = true;
        extendedSelectors[this.removeExtendedSelector.selector] = true;

        // Fee parameters (on privacy pool and yield vault)
        extendedSelectors[bytes4(keccak256("setShieldFee(uint120)"))] = true;
        extendedSelectors[bytes4(keccak256("setUnshieldFee(uint120)"))] = true;
        extendedSelectors[bytes4(keccak256("setYieldFeeBps(uint256)"))] = true;

        // Governance parameter changes (on governor, via timelock)
        extendedSelectors[bytes4(keccak256("setQuietPeriodDuration(uint256)"))] = true;

        // Security Council management
        extendedSelectors[this.setSecurityCouncil.selector] = true;

        // Steward election/removal (on TreasurySteward)
        extendedSelectors[bytes4(keccak256("electSteward(address)"))] = true;
        extendedSelectors[bytes4(keccak256("removeSteward()"))] = true;

        // Steward budget management (on ArmadaTreasuryGov)
        extendedSelectors[bytes4(keccak256("addStewardBudgetToken(address,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("updateStewardBudgetToken(address,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("removeStewardBudgetToken(address)"))] = true;

        // ARM token transfer whitelist
        extendedSelectors[bytes4(keccak256("addToWhitelist(address)"))] = true;

        // Revenue definition expansion (on RevenueCounter)
        extendedSelectors[bytes4(keccak256("setFeeCollector(address)"))] = true;


        // Treasury outflow limit parameters
        extendedSelectors[bytes4(keccak256("setOutflowWindow(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitBps(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitAbsolute(address,uint256)"))] = true;

        // UUPS upgrade selectors
        extendedSelectors[bytes4(keccak256("upgradeTo(address)"))] = true;
        extendedSelectors[bytes4(keccak256("upgradeToAndCall(address,bytes)"))] = true;
    }

    // ============ Quorum Exclusion ============

    /// @notice One-time setter: register addresses whose ARM balances are excluded from quorum.
    /// Deployer-only; locks permanently after the first call.
    /// Intended for contracts holding non-voteable ARM (e.g. crowdfund).
    function setExcludedAddresses(address[] calldata addrs) external {
        require(msg.sender == deployer, "ArmadaGovernor: not deployer");
        require(!excludedAddressesLocked, "ArmadaGovernor: already locked");

        excludedAddressesLocked = true;
        for (uint256 i = 0; i < addrs.length; i++) {
            require(addrs[i] != address(0), "ArmadaGovernor: zero address");
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
        require(msg.sender == deployer, "ArmadaGovernor: not deployer");
        require(!crowdfundAddressLocked, "ArmadaGovernor: already locked");
        require(_crowdfund != address(0), "ArmadaGovernor: zero address");

        crowdfundAddressLocked = true;
        crowdfundAddress = _crowdfund;

        emit CrowdfundAddressSet(_crowdfund);
    }

    /// @notice One-time setter: register the TreasurySteward contract.
    /// Deployer-only; locks permanently after the first call.
    function setStewardContract(address _steward) external {
        require(msg.sender == deployer, "ArmadaGovernor: not deployer");
        require(!stewardContractLocked, "ArmadaGovernor: already locked");
        require(_steward != address(0), "ArmadaGovernor: zero address");

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
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(
            proposalType != ProposalType.VetoRatification && proposalType != ProposalType.Steward,
            "ArmadaGovernor: immutable proposal type"
        );
        require(
            params.votingDelay >= MIN_VOTING_DELAY && params.votingDelay <= MAX_VOTING_DELAY,
            "ArmadaGovernor: votingDelay out of bounds"
        );
        require(
            params.votingPeriod >= MIN_VOTING_PERIOD && params.votingPeriod <= MAX_VOTING_PERIOD,
            "ArmadaGovernor: votingPeriod out of bounds"
        );
        require(
            params.executionDelay >= MIN_EXECUTION_DELAY && params.executionDelay <= MAX_EXECUTION_DELAY,
            "ArmadaGovernor: executionDelay out of bounds"
        );
        require(
            params.quorumBps >= MIN_QUORUM_BPS && params.quorumBps <= MAX_QUORUM_BPS,
            "ArmadaGovernor: quorumBps out of bounds"
        );

        proposalTypeParams[proposalType] = params;
        emit ProposalTypeParamsUpdated(proposalType, params);
    }

    /// @notice Update the governance quiet period duration.
    /// @dev Only callable by the timelock (requires a governance vote).
    ///      Setting to 0 removes the quiet period entirely.
    function setQuietPeriodDuration(uint256 _duration) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(_duration <= MAX_QUIET_PERIOD, "ArmadaGovernor: exceeds max");

        quietPeriodDuration = _duration;
        emit QuietPeriodUpdated(_duration);
    }

    // ============ Extended Selector Management ============

    /// @notice Register a function selector that forces Extended proposal classification.
    /// @dev Only callable by the timelock (requires an extended governance vote, since
    ///      this selector is itself registered as extended).
    function addExtendedSelector(bytes4 selector) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(!extendedSelectors[selector], "ArmadaGovernor: selector already extended");

        extendedSelectors[selector] = true;
        emit ExtendedSelectorAdded(selector);
    }

    /// @notice Remove a function selector from the extended classification registry.
    /// @dev Only callable by the timelock (requires an extended governance vote).
    function removeExtendedSelector(bytes4 selector) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(extendedSelectors[selector], "ArmadaGovernor: selector not extended");

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
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        emit SecurityCouncilUpdated(securityCouncil, newSC);
        securityCouncil = newSC;
    }

    // ============ Veto Mechanism ============

    /// @notice Security Council vetoes a queued proposal, triggering a ratification vote.
    /// @param proposalId The queued proposal to veto
    /// @param rationaleHash Off-chain rationale hash for verifiability
    function veto(uint256 proposalId, bytes32 rationaleHash) external {
        require(msg.sender == securityCouncil, "ArmadaGovernor: not security council");
        require(securityCouncil != address(0), "ArmadaGovernor: SC ejected");
        require(state(proposalId) == ProposalState.Queued, "ArmadaGovernor: not queued");

        // Double-veto prevention: community denied a veto on identical calldata
        bytes32 calldataHash = _proposalCalldataHash(proposalId);
        require(!vetoDeniedHashes[calldataHash], "ArmadaGovernor: community overrode, no double veto");

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
        require(vetoedId != 0, "ArmadaGovernor: not a ratification proposal");

        Proposal storage p = _proposals[ratificationId];
        require(block.timestamp > p.voteEnd, "ArmadaGovernor: voting not ended");
        require(!p.executed, "ArmadaGovernor: already resolved");

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
            _uint2str(vetoedProposalId),
            " | rationale: ",
            _bytes32ToHex(rationaleHash)
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

    /// @dev Convert uint to decimal string for ratification description.
    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Convert bytes32 to hex string (0x-prefixed) for ratification description.
    function _bytes32ToHex(bytes32 value) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory str = new bytes(66); // "0x" + 64 hex chars
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = hexChars[uint8(value[i] >> 4)];
            str[3 + i * 2] = hexChars[uint8(value[i] & 0x0f)];
        }
        return string(str);
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
        require(!windDownActive, "ArmadaGovernor: governance ended");
        require(stewardContract != address(0), "ArmadaGovernor: steward contract not set");
        require(
            msg.sender == ITreasurySteward(stewardContract).currentSteward(),
            "ArmadaGovernor: not current steward"
        );
        require(
            ITreasurySteward(stewardContract).isStewardActive(),
            "ArmadaGovernor: steward not active"
        );
        require(!stewardChannelPaused, "ArmadaGovernor: steward channel paused");
        require(tokens.length > 0, "ArmadaGovernor: empty proposal");
        require(
            tokens.length == recipients.length && tokens.length == amounts.length,
            "ArmadaGovernor: length mismatch"
        );
        _checkQuietPeriod();

        // Self-payment check: steward cannot be a recipient in any spend
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != msg.sender, "ArmadaGovernor: self-payment not allowed");
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

        uint256 proposalId = ++proposalCount;
        _initProposal(proposalId, ProposalType.Steward, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        // No bond required for steward proposals — the steward is an elected role
        // operating within budget limits. Bonds are for standard/extended proposals only.

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
        require(p.id != 0, "ArmadaGovernor: unknown proposal");
        require(p.proposalType == ProposalType.Steward, "ArmadaGovernor: not steward proposal");
        require(block.timestamp > p.voteEnd, "ArmadaGovernor: voting not ended");
        require(!stewardProposalResolved[proposalId], "ArmadaGovernor: already resolved");

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
    }

    /// @notice Resume the steward channel after a circuit breaker pause.
    /// Standard proposal (20% quorum, 7-day voting) per governance spec §Circuit breaker.
    function resumeStewardChannel() external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(stewardChannelPaused, "ArmadaGovernor: not paused");

        stewardChannelPaused = false;
        consecutiveLowParticipationCount = 0;

        emit StewardChannelResumed();
    }

    // ============ Wind-Down ============

    /// @notice One-time setter: register the wind-down contract address.
    /// Callable by timelock (governance) since the wind-down contract may be deployed
    /// after the governor and needs a governance-approved registration.
    function setWindDownContract(address _windDownContract) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(!windDownContractSet, "ArmadaGovernor: wind-down contract already set");
        require(_windDownContract != address(0), "ArmadaGovernor: zero address");

        windDownContractSet = true;
        windDownContract = _windDownContract;

        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Called by the wind-down contract to permanently disable governance.
    /// Once active, no new proposals can be created. Existing proposals in flight
    /// (Active, Succeeded, Queued) can still complete their lifecycle.
    function setWindDownActive() external {
        require(msg.sender == windDownContract, "ArmadaGovernor: not wind-down contract");
        require(windDownContract != address(0), "ArmadaGovernor: wind-down contract not set");
        require(!windDownActive, "ArmadaGovernor: wind-down already active");

        windDownActive = true;

        emit WindDownActivated();
    }

    // ============ Adapter Registry Management ============

    /// @notice Authorize an adapter to interact with the protocol.
    /// Adapters are deployed independently and authorized via standard governance proposal.
    function authorizeAdapter(address adapter) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(adapter != address(0), "ArmadaGovernor: zero address");
        require(!authorizedAdapters[adapter], "ArmadaGovernor: already authorized");

        authorizedAdapters[adapter] = true;
        withdrawOnlyAdapters[adapter] = false; // Clear withdraw-only in case of re-authorization

        emit AdapterAuthorized(adapter);
    }

    /// @notice Deauthorize an adapter, setting it to withdraw-only mode.
    /// Users can still exit positions through a withdraw-only adapter.
    function deauthorizeAdapter(address adapter) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(authorizedAdapters[adapter], "ArmadaGovernor: not authorized");

        authorizedAdapters[adapter] = false;
        withdrawOnlyAdapters[adapter] = true;

        emit AdapterDeauthorized(adapter);
    }

    /// @notice Fully remove an adapter after the withdraw-only transition period.
    /// After this, the adapter has no protocol access.
    function fullDeauthorizeAdapter(address adapter) external {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
        require(withdrawOnlyAdapters[adapter], "ArmadaGovernor: not withdraw-only");

        withdrawOnlyAdapters[adapter] = false;

        emit AdapterFullyDeauthorized(adapter);
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
        require(!windDownActive, "ArmadaGovernor: governance ended");
        require(targets.length > 0, "ArmadaGovernor: empty proposal");
        require(
            targets.length == values.length && targets.length == calldatas.length,
            "ArmadaGovernor: length mismatch"
        );
        require(
            proposalType != ProposalType.VetoRatification && proposalType != ProposalType.Steward,
            "ArmadaGovernor: auto-created only"
        );
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
            require(
                armToken.transferFrom(msg.sender, address(this), PROPOSAL_BOND),
                "ArmadaGovernor: bond transfer failed"
            );
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
        require(p.id != 0, "ArmadaGovernor: unknown proposal");
        require(block.timestamp >= p.voteStart, "ArmadaGovernor: voting not started");
        require(block.timestamp <= p.voteEnd, "ArmadaGovernor: voting ended");
        require(support <= 2, "ArmadaGovernor: invalid vote type");

        uint256 weight = armToken.getPastVotes(msg.sender, p.snapshotBlock);
        require(weight > 0, "ArmadaGovernor: no voting power");

        if (hasVoted[proposalId][msg.sender]) {
            // Vote change: subtract from old bucket, add to new bucket
            uint8 oldSupport = voteChoice[proposalId][msg.sender];
            require(oldSupport != support, "ArmadaGovernor: same vote");

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
        require(state(proposalId) == ProposalState.Succeeded, "ArmadaGovernor: not succeeded");

        Proposal storage p = _proposals[proposalId];
        require(p.proposalType != ProposalType.VetoRatification, "ArmadaGovernor: use resolveRatification");
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
    function execute(uint256 proposalId) external payable nonReentrant whenNotPaused {
        require(state(proposalId) == ProposalState.Queued, "ArmadaGovernor: not queued");

        Proposal storage p = _proposals[proposalId];
        require(p.proposalType != ProposalType.VetoRatification, "ArmadaGovernor: use resolveRatification");
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

    /// @notice Claim a proposal bond after the lock period has elapsed.
    /// Bond is always returned — lock periods vary by defeat reason.
    function claimBond(uint256 proposalId) external nonReentrant {
        BondInfo storage bond = proposalBonds[proposalId];
        require(bond.amount > 0, "ArmadaGovernor: no bond");
        require(!bond.claimed, "ArmadaGovernor: bond already claimed");

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
                require(rat.executed, "ArmadaGovernor: ratification not resolved");
                unlockTime = 0;
            } else {
                // Proposer self-cancelled during Pending: immediately claimable
                unlockTime = 0;
            }
        } else if (currentState == ProposalState.Defeated) {
            // Determine defeat reason: quorum not met vs majority against
            bool quorumMet = _quorumReached(proposalId);
            if (!quorumMet) {
                unlockTime = p.voteEnd + BOND_LOCK_QUORUM_FAIL;
            } else {
                // Quorum met but majority against (or expired grace period)
                unlockTime = p.voteEnd + BOND_LOCK_VOTE_FAIL;
            }
        } else {
            revert("ArmadaGovernor: proposal not in terminal state");
        }

        require(block.timestamp >= unlockTime, "ArmadaGovernor: bond still locked");

        bond.claimed = true;
        require(
            armToken.transfer(bond.depositor, bond.amount),
            "ArmadaGovernor: bond return failed"
        );

        emit BondClaimed(proposalId, bond.depositor, bond.amount);
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
    ///      crowdfund is registered, quiet period is zero, or crowdfund isn't finalized.
    function _checkQuietPeriod() internal view {
        if (crowdfundAddress == address(0) || quietPeriodDuration == 0) return;

        uint256 _finalizedAt = IArmadaCrowdfundReadable(crowdfundAddress).finalizedAt();
        if (_finalizedAt == 0) return;

        require(
            block.timestamp >= _finalizedAt + quietPeriodDuration,
            "ArmadaGovernor: quiet period active"
        );
    }

    // ============ UUPS ============

    /// @dev Only the timelock (governance) can authorize upgrades.
    ///      The upgradeTo/upgradeToAndCall selectors are registered as extended selectors,
    ///      so upgrade proposals automatically require Extended-type quorum and timing.
    function _authorizeUpgrade(address) internal override {
        require(msg.sender == address(timelock), "ArmadaGovernor: not timelock");
    }

    // ============ Storage Gap ============

    /// @dev Reserved storage for future upgrades. 23 state slots + 27 gap = 50 total.
    uint256[27] private __gap;
}
