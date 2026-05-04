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


/// @dev Minimal interface for reading treasury limits at queue time.
///      Matches the signatures of ArmadaTreasuryGov.getOutflowStatus and getStewardBudget.
///      The `Outflow` name is retained because the queue-time gates collectively guard
///      treasury outflow paths (rolling-window outflow ceiling + per-token steward budget).
interface IArmadaTreasuryOutflow {
    function getOutflowStatus(address token) external view returns (
        uint256 effectiveLimit,
        uint256 recentOutflow,
        uint256 available
    );
    function getStewardBudget(address token) external view returns (
        uint256 budget,
        uint256 spent,
        uint256 remaining
    );
}


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
    error Gov_SingleVetoRule();
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
    error Gov_SelectorAlreadyStandard();
    error Gov_SelectorNotExtended();
    error Gov_SelfPaymentNotAllowed();
    error Gov_StewardCalldataClassifiedAsExtended();
    error Gov_StewardContractNotSet();
    error Gov_StewardNotActive();
    error Gov_StewardProposerNoLongerActive();
    error Gov_UnknownProposal();
    error Gov_UpdateDelayExceedsCap(uint256 requested, uint256 cap);
    error Gov_UseResolveRatification();
    error Gov_VotingEnded();
    error Gov_VotingNotEnded();
    error Gov_VotingNotStarted();
    error Gov_VotingDelayOutOfBounds();
    error Gov_VotingPeriodOutOfBounds();
    error Gov_WouldBreakOutflowDelayInvariant();
    error Gov_WindDownAlreadyActive();
    error Gov_WindDownContractAlreadySet();
    error Gov_WindDownContractNotSet();
    error Gov_SCEjected();
    error Gov_SignalingMustBeEmpty();
    error Gov_SignalingNoExecution();
    error Gov_DuplicateExcludedAddress();
    error Gov_OutflowInfeasible();
    error Gov_StewardBudgetInfeasible();

    // ============ Types ============

    // Field order packs proposer (20) + proposalType (1) + 4 bools (4) into one
    // 25-byte slot (audit-68). Reordering lives in this struct definition because
    // Proposal is stored in a mapping (`_proposals[id]`), so the struct's internal
    // layout determines per-instance slot offsets — must land pre-mainnet (any
    // change after deploy corrupts every existing proposal's stored fields).
    struct Proposal {
        uint256 id;

        // Packed slot: 20 + 1 + 1 + 1 + 1 + 1 = 25 bytes
        address proposer;
        ProposalType proposalType;
        bool executed;
        bool canceled;
        bool queued;
        bool vetoRatificationDenied; // prevents re-veto of a proposal restored after community denied a veto

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
    // excludedAddressesLocked moved into the packed lock-flag slot below (audit-68).

    // Voter tracking per proposal
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => uint8)) public voteChoice;

    // Proposal type parameters
    mapping(ProposalType => ProposalParams) public proposalTypeParams;

    // Proposal threshold: 5,000 ARM (per GOVERNANCE.md §Proposal threshold)
    uint256 public constant PROPOSAL_THRESHOLD = 5_000e18;

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

    // Mirror of ArmadaTreasuryGov.LIMIT_ACTIVATION_DELAY. Duplicated here (instead of
    // read cross-contract) to keep the governor under the 24576-byte mainnet deploy limit.
    // The two constants must stay in sync; a divergence test in test/ asserts parity at
    // deploy time, so a future edit that changes one without the other will fail CI.
    uint256 public constant TREASURY_OUTFLOW_ACTIVATION_DELAY = 24 days;

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
    // Packed lock-flag slot (audit-68): 3 bools + address = 23 bytes in one slot,
    // also absorbs `excludedAddressesLocked` (relocated from earlier in the file).
    bool public excludedAddressesLocked;
    bool public windDownActive;
    bool public windDownContractSet;
    address public windDownContract;

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
    bytes4 public constant DISTRIBUTE_ETH_SELECTOR = bytes4(keccak256("distributeETH(address,uint256)"));
    bytes4 public constant STEWARD_SPEND_SELECTOR = bytes4(keccak256("stewardSpend(address,address,uint256)"));
    uint256 public constant TREASURY_EXTENDED_THRESHOLD_BPS = 500; // 5%

    // Timelock.updateDelay(uint256) — guarded at propose() time. Setting the timelock's
    // _minDelay above MAX_EXECUTION_DELAY would permanently brick queue() because every
    // proposal's executionDelay (≤ MAX_EXECUTION_DELAY) would fall below getMinDelay().
    // NOTE: This guard is governor-scoped. It assumes PROPOSER_ROLE on the timelock is
    // held ONLY by this governor. If another proposer is ever granted the role, that
    // path bypasses this check and this guard must be re-evaluated.
    bytes4 public constant UPDATE_DELAY_SELECTOR = bytes4(keccak256("updateDelay(uint256)"));

    // Fail-closed classification: selectors not in extendedSelectors AND not in
    // standardSelectors default to Extended. This prevents bypass via unclassified
    // selectors (e.g. wrapper/forwarder contracts, newly added protocol functions).
    mapping(bytes4 => bool) public standardSelectors;

    // ============ Veto & Ratification ============

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
    event ProposalRestored(uint256 indexed proposalId);
    event RatificationResolved(uint256 indexed ratificationId, bool vetoUpheld);
    event SecurityCouncilEjected(uint256 indexed ratificationId);
    event ExcludedAddressesSet(address[] addresses);
    event ExcludedAddressAdded(address indexed addr);
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

        // Signaling: non-executable text-only proposals. Standard timing, no execution phase.
        // Immutable — cannot be changed via setProposalTypeParams().
        proposalTypeParams[ProposalType.Signaling] = ProposalParams({
            votingDelay: 2 days,
            votingPeriod: 7 days,
            executionDelay: 0,
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
        // Steward budget token management (on ArmadaTreasuryGov). addStewardBudgetToken
        // is always loosening (grants a new spending authority) → Extended.
        // updateStewardBudgetToken is direction-dependent (a smaller limit / shorter
        // window is tightening; a larger limit / longer window is loosening) — until
        // directional classification lands it stays flat-Extended, which over-gates
        // the tightening direction but is fail-safe.
        extendedSelectors[bytes4(keccak256("addStewardBudgetToken(address,uint256,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("updateStewardBudgetToken(address,uint256,uint256)"))] = true;
        // Treasury outflow limit parameters
        extendedSelectors[bytes4(keccak256("setOutflowWindow(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitBps(address,uint256)"))] = true;
        extendedSelectors[bytes4(keccak256("setOutflowLimitAbsolute(address,uint256)"))] = true;
        // Adapter authorization (on AdapterRegistry) — loosening: grants a new contract
        // access to the protocol's shielded yield. Deauthorization is Standard (see below).
        extendedSelectors[bytes4(keccak256("authorizeAdapter(address)"))] = true;
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
        standardSelectors[DISTRIBUTE_ETH_SELECTOR] = true; // distributeETH() below the 5% threshold
        standardSelectors[bytes4(keccak256("stewardSpend(address,address,uint256)"))] = true;
        // transferTo / transferETHTo are intentionally NOT registered. They are
        // wind-down-only on the treasury (require msg.sender == windDownContract),
        // so any governance proposal calling them via the timelock would revert.
        // Leaving them un-registered makes them fail-closed to Extended — a more
        // honest signal to proposers that these are not governance paths.
        // ARM token transfer enable — one-way, irreversible, callable via governance or wind-down
        standardSelectors[bytes4(keccak256("setTransferable(bool)"))] = true;
        // Steward removal — defensive/emergency action, lower bar per spec
        standardSelectors[bytes4(keccak256("removeSteward()"))] = true;
        // Permissionless crowdfund sweep — anyone can call directly, governance path is optional
        standardSelectors[bytes4(keccak256("withdrawUnallocatedArm()"))] = true;
        // Adapter deauthorization (on AdapterRegistry) — tightening: revokes an adapter's
        // access to the protocol. Paired with authorizeAdapter (Extended) above.
        standardSelectors[bytes4(keccak256("deauthorizeAdapter(address)"))] = true;
        standardSelectors[bytes4(keccak256("fullDeauthorizeAdapter(address)"))] = true;
        // Wind-down operational parameters (on ArmadaWindDown) — routine threshold /
        // deadline adjustments. Directional nuance (e.g. extending the deadline is
        // loosening) is not yet enforced in code; tracked separately for future work.
        standardSelectors[bytes4(keccak256("setRevenueThreshold(uint256)"))] = true;
        standardSelectors[bytes4(keccak256("setWindDownDeadline(uint256)"))] = true;
        // Non-stablecoin revenue attestation (on RevenueCounter) — governance attests
        // USD value of non-stablecoin fees (e.g. ETH). Operational governance task.
        // addRevenue is the routine increment-style path; attestRevenue (SET) is
        // reserved for confirmed-error correction (see RevenueCounter natspec).
        standardSelectors[bytes4(keccak256("addRevenue(uint256)"))] = true;
        standardSelectors[bytes4(keccak256("attestRevenue(uint256)"))] = true;
        // removeStewardBudgetToken — always tightening (revokes a spending authority,
        // no parameter to interpret either way). Standard quorum/timing matches the
        // spec's "tightening is easy" directional principle and prevents a 14-day
        // frontrun window between Extended-cut activation and the 9-day steward
        // proposal cycle.
        standardSelectors[bytes4(keccak256("removeStewardBudgetToken(address)"))] = true;
    }

    // ============ Quorum Exclusion ============

    /// @notice One-time setter: register addresses whose ARM balances are excluded from quorum.
    /// Deployer-only; locks permanently after the first call.
    /// Intended for contracts holding non-voteable ARM (e.g. crowdfund, RevenueLock).
    /// Post-bootstrap additions go through the timelock-gated addExcludedAddress.
    function setExcludedAddresses(address[] calldata addrs) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        if (excludedAddressesLocked) revert Gov_AlreadyLocked();

        excludedAddressesLocked = true;
        // Duplicate detection lives in _registerExcludedAddress, which checks the
        // candidate against the (growing) _excludedFromQuorum list. _initProposal
        // sums balanceOf across this list, so a duplicate would double-count its
        // balance into excludedBalance and lower the quorum threshold below the
        // spec value. The treasury is implicitly excluded by the quorum-denominator
        // math (its balance is subtracted separately at proposal creation), so
        // listing it here would be an explicit duplicate of the implicit exclusion.
        // Realistic input is 2-5 addresses; O(n^2) is gas-trivial at that size.
        for (uint256 i = 0; i < addrs.length; i++) {
            _registerExcludedAddress(addrs[i]);
        }

        emit ExcludedAddressesSet(addrs);
    }

    /// @notice Append a single address to the quorum-exclusion list. Timelock-only.
    /// Used post-launch to register follow-on RevenueLock cohorts (revenue-gated grants
    /// for new teammembers / airdrops) or replacement Crowdfund instances whose ARM
    /// holdings would otherwise inflate the quorum denominator. Same dedup + treasury
    /// + zero-address checks as the bootstrap setter.
    function addExcludedAddress(address candidate) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        _registerExcludedAddress(candidate);
        emit ExcludedAddressAdded(candidate);
    }

    /// @dev Shared validation+push for both bootstrap and post-launch addition paths.
    function _registerExcludedAddress(address candidate) internal {
        if (candidate == address(0)) revert Gov_ZeroAddress();
        if (candidate == treasuryAddress) revert Gov_DuplicateExcludedAddress();
        for (uint256 i = 0; i < _excludedFromQuorum.length; i++) {
            if (_excludedFromQuorum[i] == candidate) revert Gov_DuplicateExcludedAddress();
        }
        _excludedFromQuorum.push(candidate);
    }

    /// @notice View excluded addresses for transparency
    function getExcludedFromQuorum() external view returns (address[] memory) {
        return _excludedFromQuorum;
    }

    /// @notice One-time setter: register the crowdfund contract for quiet period checks.
    /// Deployer-only; locks permanently after the first call.
    function setCrowdfundAddress(address _crowdfund) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        // Parameter check before cold SLOAD on the lock flag (audit-79).
        if (_crowdfund == address(0)) revert Gov_ZeroAddress();
        if (crowdfundAddressLocked) revert Gov_AlreadyLocked();

        crowdfundAddressLocked = true;
        crowdfundAddress = _crowdfund;

        emit CrowdfundAddressSet(_crowdfund);
    }

    /// @notice One-time setter: register the TreasurySteward contract.
    /// Deployer-only; locks permanently after the first call.
    function setStewardContract(address _steward) external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        // Parameter check before cold SLOAD on the lock flag (audit-79).
        if (_steward == address(0)) revert Gov_ZeroAddress();
        if (stewardContractLocked) revert Gov_AlreadyLocked();

        stewardContractLocked = true;
        stewardContract = _steward;

        emit StewardContractSet(_steward);
    }

    /// @notice Clear the deployer address after all one-time setters have been called.
    /// Deployer-only. Eliminates the deployer as a privileged address in upgradeable storage,
    /// preventing future UUPS upgrades from inheriting deployer-gated privileges.
    function clearDeployer() external {
        if (msg.sender != deployer) revert Gov_NotDeployer();
        // Emit before SSTORE — avoids a dead stack slot across the write (audit-91).
        emit DeployerCleared(deployer);
        deployer = address(0);
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
        if (proposalType == ProposalType.VetoRatification || proposalType == ProposalType.Steward || proposalType == ProposalType.Signaling) revert Gov_ImmutableProposalType();
        if (params.votingDelay < MIN_VOTING_DELAY || params.votingDelay > MAX_VOTING_DELAY) revert Gov_VotingDelayOutOfBounds();
        if (params.votingPeriod < MIN_VOTING_PERIOD || params.votingPeriod > MAX_VOTING_PERIOD) revert Gov_VotingPeriodOutOfBounds();
        if (params.executionDelay < MIN_EXECUTION_DELAY || params.executionDelay > MAX_EXECUTION_DELAY) revert Gov_ExecutionDelayOutOfBounds();
        if (params.quorumBps < MIN_QUORUM_BPS || params.quorumBps > MAX_QUORUM_BPS) revert Gov_QuorumBpsOutOfBounds();

        // Extended timing invariant: the full Extended proposal cycle must stay strictly
        // shorter than the treasury's outflow-loosening activation delay. Without this,
        // a captured governance could stretch the Extended cycle to meet or exceed the
        // activation delay, letting a second drain proposal complete its own cycle exactly
        // as a scheduled loosening activates.
        if (proposalType == ProposalType.Extended) {
            uint256 cycle = params.votingDelay + params.votingPeriod + params.executionDelay;
            if (cycle >= TREASURY_OUTFLOW_ACTIVATION_DELAY) revert Gov_WouldBreakOutflowDelayInvariant();
        }

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
        // Mutual-exclusion guard (audit-96): reject if the selector is already
        // registered as Standard. Without this, a selector can be true in both
        // maps; Extended wins at classification time but a later removeExtendedSelector
        // would silently downgrade to Standard via the latent entry.
        if (standardSelectors[selector]) revert Gov_SelectorAlreadyStandard();

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
        // Mutual-exclusion guards (audit-96): the two classification maps must
        // stay disjoint. Reject double-add into Standard, and reject if the
        // selector is already registered as Extended (a latent dual-state would
        // mask a later removeStandardSelector as a real change while runtime
        // classification still flows through Extended).
        if (standardSelectors[selector]) revert Gov_SelectorAlreadyStandard();
        if (extendedSelectors[selector]) revert Gov_SelectorAlreadyExtended();
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

    /// @notice Set or replace the Security Council address.
    /// @dev Two callers: (1) the timelock — the post-bootstrap governance path, used
    ///      for replacements, ejection (newSC == address(0)), and re-install after
    ///      ejection; (2) the deployer, but only while the deployer role is still
    ///      held (deployer != address(0)) — the bootstrap path. clearDeployer()
    ///      permanently closes the deployer path. This matches the asymmetric-
    ///      bootstrap pattern used for setCrowdfundAddress / setStewardContract,
    ///      and avoids a launch-window in which no SC exists because governance
    ///      cannot meet quorum yet.
    function setSecurityCouncil(address newSC) external {
        // Authorized: timelock (governance), or deployer pre-clearDeployer (bootstrap).
        address d = deployer;
        if (msg.sender != address(timelock) && (msg.sender != d || d == address(0))) {
            revert Gov_NotTimelock();
        }
        emit SecurityCouncilUpdated(securityCouncil, newSC);
        securityCouncil = newSC;
    }

    // ============ Veto Mechanism ============

    /// @notice Security Council vetoes a queued proposal, triggering a ratification vote.
    /// @param proposalId The queued proposal to veto
    /// @param rationaleHash Off-chain rationale hash for verifiability
    function veto(uint256 proposalId, bytes32 rationaleHash) external {
        // Cache securityCouncil and timelock — each read twice below (audit-76).
        address sc = securityCouncil;
        if (msg.sender != sc) revert Gov_NotSecurityCouncil();
        if (sc == address(0)) revert Gov_SCEjected();
        if (state(proposalId) != ProposalState.Queued) revert Gov_NotQueued();

        Proposal storage p = _proposals[proposalId];

        // Per-proposal re-veto prevention: community already denied a veto on this proposal
        if (p.vetoRatificationDenied) revert Gov_SingleVetoRule();

        // Cancel the original proposal
        p.canceled = true;

        // Cancel the timelock operation
        TimelockController tl = timelock;
        bytes32 timelockId = tl.hashOperationBatch(
            p.targets, p.values, p.calldatas, 0, _proposalSalt(proposalId)
        );
        tl.cancel(timelockId);

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
            // Community denies the veto → eject SC, restore proposal
            address oldSC = securityCouncil;
            securityCouncil = address(0);

            // Restore the original proposal to Queued state
            Proposal storage orig = _proposals[vetoedId];
            orig.canceled = false;
            orig.vetoRatificationDenied = true; // prevent re-veto of this specific proposal

            // Re-queue in timelock with fresh minimum delay.
            // cancel() cleared _timestamps[id] so scheduleBatch() accepts the same operation ID.
            // Cache timelock: read twice (audit-76).
            TimelockController tl = timelock;
            tl.scheduleBatch(
                orig.targets, orig.values, orig.calldatas,
                0, // no predecessor
                _proposalSalt(vetoedId),
                tl.getMinDelay()
            );

            emit ProposalRestored(vetoedId);
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
    ) internal returns (uint256 ratId) {
        ratId = ++proposalCount;

        // Description is generic; vetoedProposalId and rationaleHash are queryable
        // on-chain via ratificationOf() mapping and ProposalVetoed event.
        string memory desc = "Veto ratification";

        // _initProposal returns voteStart/voteEnd so the emit below doesn't SLOAD them (audit-75).
        (uint256 voteStart_, uint256 voteEnd_) = _initProposal(ratId, ProposalType.VetoRatification, desc);

        // Ratification has no execution calldata — consequences handled by resolveRatification()
        // (targets, values, calldatas arrays remain empty/default)

        // Store bidirectional mappings
        ratificationOf[ratId] = vetoedProposalId;
        vetoRatificationId[vetoedProposalId] = ratId;

        emit ProposalCreated(
            ratId, msg.sender, ProposalType.VetoRatification,
            voteStart_, voteEnd_, desc
        );
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
    ) external returns (uint256 proposalId) {
        if (windDownActive) revert Gov_GovernanceEnded();
        // Cache stewardContract: read 3 times (zero check, getCurrentSteward call) (audit-76).
        address sc = stewardContract;
        if (sc == address(0)) revert Gov_StewardContractNotSet();
        // Combined accessor: one CALL fetches both the elected address and the
        // active flag, avoiding a duplicate currentSteward SLOAD inside isStewardActive.
        (address steward, bool isActive) = ITreasurySteward(sc).getCurrentSteward();
        if (msg.sender != steward) revert Gov_NotCurrentSteward();
        if (!isActive) revert Gov_StewardNotActive();

        if (tokens.length == 0) revert Gov_EmptyProposal();
        if (tokens.length != recipients.length || tokens.length != amounts.length) revert Gov_LengthMismatch();
        _checkQuietPeriod();

        // Self-payment check: steward cannot be a recipient in any spend
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == msg.sender) revert Gov_SelfPaymentNotAllowed();
        }

        // Governor constructs the calldata — steward only provides structured spend params.
        // Cache treasuryAddress: read on every iteration of the per-token loop (audit-76).
        address treasury_ = treasuryAddress;
        address[] memory targets = new address[](tokens.length);
        uint256[] memory values = new uint256[](tokens.length);
        bytes[] memory calldatas = new bytes[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            targets[i] = treasury_;
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

        proposalId = ++proposalCount;
        // NOTE: would prefer to consume _initProposal's tuple return per audit-75,
        // but propose() and proposeStewardSpend() both push stack-too-deep when
        // capturing voteStart_/voteEnd_ locals (Foundry compiles without viaIR).
        // _createRatificationProposal has shorter stack and DOES consume the tuple.
        _initProposal(proposalId, ProposalType.Steward, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        emit ProposalCreated(
            proposalId, msg.sender, ProposalType.Steward,
            p.voteStart, p.voteEnd, description
        );
    }

    // ============ Wind-Down ============

    /// @notice One-time setter: register the wind-down contract address.
    /// Callable by timelock (governance) since the wind-down contract may be deployed
    /// after the governor and needs a governance-approved registration.
    function setWindDownContract(address _windDownContract) external {
        if (msg.sender != address(timelock)) revert Gov_NotTimelock();
        // Parameter check before cold SLOAD on the lock flag (audit-79).
        if (_windDownContract == address(0)) revert Gov_ZeroAddress();
        if (windDownContractSet) revert Gov_WindDownContractAlreadySet();

        windDownContractSet = true;
        windDownContract = _windDownContract;

        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Called by the wind-down contract to permanently disable governance.
    /// Once active, the entire proposal lifecycle freezes:
    ///   - propose / proposeStewardSpend reject new proposals.
    ///   - queue rejects pre-trigger Succeeded proposals.
    ///   - execute rejects pre-trigger Queued proposals.
    /// Voting on already-Active proposals can complete (no on-chain harm: the
    /// resulting Succeeded state simply cannot progress past queue).
    function setWindDownActive() external {
        // Cache windDownContract: read twice (audit-76).
        address wd = windDownContract;
        if (msg.sender != wd) revert Gov_NotWindDownContract();
        if (wd == address(0)) revert Gov_WindDownContractNotSet();
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
    ) external returns (uint256 proposalId) {
        if (windDownActive) revert Gov_GovernanceEnded();
        if (proposalType == ProposalType.VetoRatification || proposalType == ProposalType.Steward) revert Gov_AutoCreatedOnly();
        _checkQuietPeriod();
        _checkProposalThreshold(msg.sender);

        // Signaling proposals are text-only: no targets, values, or calldatas allowed.
        // Executable proposals must have at least one target with matching arrays.
        if (proposalType == ProposalType.Signaling) {
            if (targets.length != 0 || values.length != 0 || calldatas.length != 0) revert Gov_SignalingMustBeEmpty();
        } else {
            if (targets.length == 0) revert Gov_EmptyProposal();
            if (targets.length != values.length || targets.length != calldatas.length) revert Gov_LengthMismatch();
        }

        // Bound timelock.updateDelay(uint256) at propose-time so a governance action
        // cannot push _minDelay above MAX_EXECUTION_DELAY and permanently brick queue().
        if (proposalType != ProposalType.Signaling) {
            _validateTimelockCalldata(targets, calldatas);
        }

        // Mechanical classification: if any calldata triggers extended, override to Extended.
        // Proposers can opt into Extended voluntarily, but cannot downgrade to Standard
        // when calldata contains extended-classified function calls.
        // Signaling proposals skip classification (no calldata to classify).
        ProposalType effectiveType = proposalType == ProposalType.Signaling
            ? ProposalType.Signaling
            : _classifyProposal(proposalType, targets, calldatas);

        proposalId = ++proposalCount;
        // NOTE: would prefer to consume _initProposal's tuple return per audit-75,
        // but capturing voteStart_/voteEnd_ locals here pushes propose() over the
        // stack-too-deep limit when compiled without viaIR (Foundry's config). The
        // other two _initProposal callers (_createRatificationProposal,
        // proposeStewardSpend) have shorter local lists and DO consume the tuple.
        _initProposal(proposalId, effectiveType, description);

        Proposal storage p = _proposals[proposalId];
        p.targets = targets;
        p.values = values;
        p.calldatas = calldatas;

        emit ProposalCreated(
            proposalId, msg.sender, effectiveType,
            p.voteStart, p.voteEnd, description
        );
    }

    /// @dev Check that proposer has at least PROPOSAL_THRESHOLD delegated voting power
    function _checkProposalThreshold(address proposer) internal view {
        uint256 proposerVotes = armToken.getPastVotes(proposer, block.number - 1);
        if (proposerVotes < PROPOSAL_THRESHOLD) revert Gov_BelowProposalThreshold();
    }

    /// @dev Initialize proposal scalar fields. Returns (voteStart, voteEnd) so the
    ///      caller's ProposalCreated emit doesn't re-SLOAD them (audit-75).
    function _initProposal(
        uint256 proposalId,
        ProposalType proposalType,
        string memory description
    ) internal returns (uint256 voteStart_, uint256 voteEnd_) {
        ProposalParams storage params = proposalTypeParams[proposalType];
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.proposalType = proposalType;
        // Compute vote-start once (also avoids the storage write→read pattern
        // for dependent vote-end calculation, audit-76).
        uint256 snapshotBlock_ = block.number - 1;
        voteStart_ = block.timestamp + params.votingDelay;
        voteEnd_ = voteStart_ + params.votingPeriod;
        p.snapshotBlock = snapshotBlock_;
        p.voteStart = voteStart_;
        p.voteEnd = voteEnd_;
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
        // Cache armToken once: read on every iteration of the excluded-list loop (audit-76).
        ArmadaToken token = armToken;
        uint256 totalSupply = token.getPastTotalSupply(snapshotBlock_);
        uint256 excludedBalance = token.balanceOf(treasuryAddress);
        uint256 excludedLen = _excludedFromQuorum.length;
        for (uint256 i = 0; i < excludedLen; i++) {
            excludedBalance += token.balanceOf(_excludedFromQuorum[i]);
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
        // Wind-down freezes the entire governance lifecycle, not just new proposals.
        // Pre-trigger Succeeded proposals must not progress; otherwise a queued
        // distribute / stewardSpend would mutate treasury ARM mid-redemption window
        // and break the redemption contract's pro-rata invariant (GOVERNANCE.md §11).
        if (windDownActive) revert Gov_GovernanceEnded();
        if (state(proposalId) != ProposalState.Succeeded) revert Gov_NotSucceeded();

        Proposal storage p = _proposals[proposalId];
        // Cache p.proposalType: read 3 times below (audit-76).
        ProposalType ptype = p.proposalType;
        if (ptype == ProposalType.VetoRatification) revert Gov_UseResolveRatification();
        if (ptype == ProposalType.Signaling) revert Gov_SignalingNoExecution();

        // Steward proposals must not be queueable after steward removal or term expiry.
        // Creation-time checks in proposeStewardSpend() verify steward status at proposal
        // time, but a steward can be removed while their proposal is still in voting.
        // getCurrentSteward returns (address, bool) in one CALL.
        if (ptype == ProposalType.Steward) {
            // Cache stewardContract: read twice (zero check + getCurrentSteward) (audit-76).
            address sc = stewardContract;
            if (sc == address(0)) revert Gov_StewardProposerNoLongerActive();
            (address steward, bool isActive) = ITreasurySteward(sc).getCurrentSteward();
            if (p.proposer != steward || !isActive) revert Gov_StewardProposerNoLongerActive();
        }

        // Queue-time outflow feasibility check: reject proposals whose aggregate
        // per-token treasury spend exceeds the current effective outflow limit.
        // See GOVERNANCE.md §Treasury Outflow Limits — "Queue-time feasibility check".
        _checkOutflowFeasibility(p.targets, p.calldatas);

        p.queued = true;

        // Copy storage arrays into memory once: passed to two cross-contract calls
        // below (hashOperationBatch + scheduleBatch). Without the copy each call
        // ABI-encodes from storage independently — duplicate per-element SLOADs.
        // Net win for any non-trivial batch (audit-76).
        address[] memory tgts = p.targets;
        uint256[] memory vals = p.values;
        bytes[] memory cdatas = p.calldatas;
        // Cache timelock: read twice (audit-76).
        TimelockController tl = timelock;
        bytes32 salt = _proposalSalt(proposalId);

        bytes32 timelockId = tl.hashOperationBatch(tgts, vals, cdatas, 0, salt);

        tl.scheduleBatch(
            tgts, vals, cdatas,
            0, // no predecessor
            salt,
            p.executionDelay
        );

        emit ProposalQueued(proposalId, timelockId);
    }

    /// @notice Execute a queued proposal after timelock delay
    function execute(uint256 proposalId) external payable nonReentrant {
        // Mirror the queue()-time wind-down gate. A proposal queued just before
        // trigger must not execute afterward — same redemption-fairness reason.
        if (windDownActive) revert Gov_GovernanceEnded();
        if (state(proposalId) != ProposalState.Queued) revert Gov_NotQueued();

        Proposal storage p = _proposals[proposalId];
        // Cache p.proposalType: read 3 times below (audit-76).
        ProposalType ptype = p.proposalType;
        if (ptype == ProposalType.VetoRatification) revert Gov_UseResolveRatification();
        if (ptype == ProposalType.Signaling) revert Gov_SignalingNoExecution();

        // Mirror the queue()-time steward check: a steward removed or expired during the
        // execution delay must not have their proposal execute. Without this, the SC veto
        // would be the only backstop for the term-expiry edge case.
        if (ptype == ProposalType.Steward) {
            // Cache stewardContract: read twice (audit-76).
            address sc = stewardContract;
            if (sc == address(0)) revert Gov_StewardProposerNoLongerActive();
            (address steward, bool isActive) = ITreasurySteward(sc).getCurrentSteward();
            if (p.proposer != steward || !isActive) revert Gov_StewardProposerNoLongerActive();
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
        // Cache p.voteEnd and p.proposalType — each read twice on different paths (audit-76).
        uint256 voteEnd_ = p.voteEnd;
        if (block.timestamp <= voteEnd_) return ProposalState.Active;
        ProposalType ptype = p.proposalType;

        // After voting ends: check quorum and majority
        if (ptype == ProposalType.Steward) {
            // Pass-by-default: defeated ONLY if quorum met AND strict majority votes against
            if (_quorumReached(proposalId) && p.againstVotes > p.forVotes) {
                return ProposalState.Defeated;
            }
        } else if (ptype == ProposalType.VetoRatification) {
            // Pass-by-default like Steward (audit-82). Returns directly because
            // VetoRatification has no queue/execute phase — resolution flows through
            // resolveRatification, which sets p.executed and is caught by the earlier
            // Executed branch. The QUEUE_GRACE_PERIOD expiry below must not apply here.
            if (_quorumReached(proposalId) && p.againstVotes > p.forVotes) {
                return ProposalState.Defeated;
            }
            return ProposalState.Succeeded;
        } else {
            if (!_quorumReached(proposalId) || !_voteSucceeded(proposalId)) {
                return ProposalState.Defeated;
            }
        }

        // Signaling proposals are terminal at outcome — no queue/execute phase.
        // Succeeded is permanent (no grace period expiry).
        if (ptype == ProposalType.Signaling) return ProposalState.Succeeded;

        if (p.queued) return ProposalState.Queued;

        // Succeeded proposals expire if not queued within the grace period
        if (block.timestamp > voteEnd_ + QUEUE_GRACE_PERIOD) {
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
    function proposalThreshold() external pure returns (uint256) {
        return PROPOSAL_THRESHOLD;
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

    /// @dev Decode the parameters of a treasury-outflow selector calldata into the
    ///      (token, amount) tuple used for aggregation. Handles distribute(),
    ///      distributeETH(), and stewardSpend(). For distributeETH(), token is set to
    ///      address(0) — the ETH sentinel used by ArmadaTreasuryGov's outflow accounting.
    ///      Returns ok=false if the selector is unrecognized or the calldata is too
    ///      short to decode the expected layout.
    ///
    ///      Shared by _classifyProposal (5% threshold gate) and _checkOutflowFeasibility
    ///      (queue-time effective-limit gate) so the two checks can never disagree on
    ///      how a given calldata is interpreted.
    function _decodeTreasuryDistribute(bytes memory data)
        internal pure returns (address token, uint256 amount, bool ok)
    {
        if (data.length < 4) return (address(0), 0, false);
        bytes4 selector = bytes4(data);

        if (selector == DISTRIBUTE_SELECTOR || selector == STEWARD_SPEND_SELECTOR) {
            // distribute(address token, address recipient, uint256 amount)
            // stewardSpend(address token, address recipient, uint256 amount)
            // 4 selector bytes + 3 * 32 param bytes = 100
            if (data.length < 100) return (address(0), 0, false);
            bytes memory params = new bytes(data.length - 4);
            for (uint256 j = 0; j < params.length; j++) {
                params[j] = data[j + 4];
            }
            (token, , amount) = abi.decode(params, (address, address, uint256));
            return (token, amount, true);
        }

        if (selector == DISTRIBUTE_ETH_SELECTOR) {
            // distributeETH(address recipient, uint256 amount)
            // 4 selector bytes + 2 * 32 param bytes = 68
            if (data.length < 68) return (address(0), 0, false);
            bytes memory params = new bytes(data.length - 4);
            for (uint256 j = 0; j < params.length; j++) {
                params[j] = data[j + 4];
            }
            (, amount) = abi.decode(params, (address, uint256));
            return (address(0), amount, true);
        }

        return (address(0), 0, false);
    }

    /// @dev Classify a proposal based on its calldata. Fail-closed: any selector not
    ///      explicitly registered as Extended or Standard defaults to Extended.
    ///      If any action targets an extended selector, the entire proposal is Extended.
    ///      Treasury-targeted distribute() and distributeETH() amounts are aggregated
    ///      per token across the entire proposal; if any token's aggregate exceeds 5%
    ///      of the spot treasury balance, force Extended. Per-token aggregation
    ///      prevents a proposer from batch-splitting one large drain into many
    ///      sub-threshold calls.
    function _classifyProposal(
        ProposalType declaredType,
        address[] memory targets,
        bytes[] memory calldatas
    ) internal view returns (ProposalType) {
        // If already Extended, no need to check further
        if (declaredType == ProposalType.Extended) return ProposalType.Extended;

        // Pass 1: per-call selector classification.
        // Any extended selector forces Extended; any unrecognized selector forces
        // Extended (fail-closed) — guarding against wrapper/forwarder bypass and
        // newly added protocol functions that haven't been classified yet.
        for (uint256 i = 0; i < calldatas.length; i++) {
            if (calldatas[i].length < 4) continue;
            bytes4 selector = bytes4(calldatas[i]);
            if (extendedSelectors[selector]) return ProposalType.Extended;
            if (!standardSelectors[selector]) return ProposalType.Extended;
        }

        // Pass 2: per-token aggregation of treasury-targeted distribute() /
        // distributeETH() amounts; force Extended if any token's aggregate exceeds
        // the 5% threshold. stewardSpend() is excluded — it is governed separately
        // by the per-token steward budget table, not by the 5% rule.
        //
        // DESIGN NOTE: Uses a spot balanceOf() check. An attacker could inflate the
        // treasury balance (by donating tokens) to make a large distribution appear
        // to be below the 5% threshold. This is accepted because: (1) donated tokens
        // are lost to the attacker, making the attack economically irrational,
        // (2) USDC lacks checkpointing so snapshot-based alternatives are not
        // available, and (3) the Security Council can veto any suspicious proposal
        // regardless of classification.
        address[] memory tokens = new address[](calldatas.length);
        uint256[] memory sums = new uint256[](calldatas.length);
        uint256 tokenCount;

        for (uint256 i = 0; i < calldatas.length; i++) {
            if (targets[i] != treasuryAddress) continue;
            if (calldatas[i].length < 4) continue;
            bytes4 selector = bytes4(calldatas[i]);
            if (selector != DISTRIBUTE_SELECTOR && selector != DISTRIBUTE_ETH_SELECTOR) continue;

            (address token, uint256 amount, bool ok) = _decodeTreasuryDistribute(calldatas[i]);
            if (!ok) continue;

            bool found;
            for (uint256 k = 0; k < tokenCount; k++) {
                if (tokens[k] == token) {
                    sums[k] += amount;
                    found = true;
                    break;
                }
            }
            if (!found) {
                tokens[tokenCount] = token;
                sums[tokenCount] = amount;
                tokenCount++;
            }
        }

        for (uint256 k = 0; k < tokenCount; k++) {
            uint256 treasuryBalance = tokens[k] == address(0)
                ? treasuryAddress.balance
                : IERC20(tokens[k]).balanceOf(treasuryAddress);
            if (treasuryBalance > 0 &&
                sums[k] > (treasuryBalance * TREASURY_EXTENDED_THRESHOLD_BPS) / 10000) {
                return ProposalType.Extended;
            }
        }

        return declaredType;
    }

    /// @dev Queue-time sanity check: reject a proposal whose aggregate per-token
    ///      treasury spend exceeds that token's current effective outflow limit, or
    ///      whose aggregate per-token stewardSpend exceeds the per-token steward
    ///      budget limit. Such a proposal can never execute under current parameters
    ///      and should not occupy the timelock queue indefinitely.
    ///
    ///      Compares against the effective limit / budget limit (the ceiling), not the
    ///      available (ceiling minus recent outflows / recent steward spending).
    ///      Proposals that fit the limit but exceed the current available are allowed
    ///      to queue and retry once the rolling window has created room.
    ///
    ///      Two independent gates run on the same iteration:
    ///      1. Aggregate outflow check: distribute() + stewardSpend() + distributeETH()
    ///         per-token sums vs treasury rolling-window outflow ceiling.
    ///      2. Aggregate steward budget check: stewardSpend()-only per-token sums vs
    ///         the per-token steward budget limit. Tokens not in the budget table
    ///         return budget=0, so any positive aggregate fails — surfacing
    ///         unauthorized-token steward proposals at queue time instead of execute.
    ///
    ///      The first two outflow selectors share the (address token, address
    ///      recipient, uint256 amount) layout; distributeETH() drops the token argument
    ///      and is aggregated under the address(0) sentinel. transferTo()/transferETHTo()
    ///      are wind-down-only paths that bypass outflow limits and are intentionally excluded.
    ///
    ///      Shares the _decodeTreasuryDistribute helper with _classifyProposal so the
    ///      classification gate and the feasibility gate cannot disagree on how a
    ///      given calldata is interpreted. View-only; reverts before any governor or
    ///      timelock state is written.
    function _checkOutflowFeasibility(
        address[] memory targets,
        bytes[] memory calldatas
    ) internal view {
        // Aggregate amounts per token using parallel arrays in memory. Proposal
        // batches are small (bounded by block gas), so O(n^2) is acceptable and
        // avoids needing a mapping or a storage slot.
        address[] memory outflowTokens = new address[](calldatas.length);
        uint256[] memory outflowSums = new uint256[](calldatas.length);
        uint256 outflowTokenCount;

        address[] memory stewardTokens = new address[](calldatas.length);
        uint256[] memory stewardSums = new uint256[](calldatas.length);
        uint256 stewardTokenCount;

        // Cache treasuryAddress once: read on every iteration of all three loops below (audit-76).
        address treasury_ = treasuryAddress;

        for (uint256 i = 0; i < calldatas.length; i++) {
            if (targets[i] != treasury_) continue;
            if (calldatas[i].length < 4) continue;
            bytes4 selector = bytes4(calldatas[i]);
            if (selector != DISTRIBUTE_SELECTOR &&
                selector != STEWARD_SPEND_SELECTOR &&
                selector != DISTRIBUTE_ETH_SELECTOR) continue;

            (address token, uint256 amount, bool ok) = _decodeTreasuryDistribute(calldatas[i]);
            if (!ok) continue;

            // Outflow aggregation covers all three treasury-outflow selectors.
            bool found;
            for (uint256 k = 0; k < outflowTokenCount; k++) {
                if (outflowTokens[k] == token) {
                    outflowSums[k] += amount;
                    found = true;
                    break;
                }
            }
            if (!found) {
                outflowTokens[outflowTokenCount] = token;
                outflowSums[outflowTokenCount] = amount;
                outflowTokenCount++;
            }

            // Steward-budget aggregation covers stewardSpend() only — distribute()
            // and distributeETH() are not gated by the steward budget table.
            if (selector == STEWARD_SPEND_SELECTOR) {
                bool sFound;
                for (uint256 k = 0; k < stewardTokenCount; k++) {
                    if (stewardTokens[k] == token) {
                        stewardSums[k] += amount;
                        sFound = true;
                        break;
                    }
                }
                if (!sFound) {
                    stewardTokens[stewardTokenCount] = token;
                    stewardSums[stewardTokenCount] = amount;
                    stewardTokenCount++;
                }
            }
        }

        for (uint256 k = 0; k < outflowTokenCount; k++) {
            (uint256 effectiveLimit,,) = IArmadaTreasuryOutflow(treasury_).getOutflowStatus(outflowTokens[k]);
            if (outflowSums[k] > effectiveLimit) revert Gov_OutflowInfeasible();
        }

        for (uint256 k = 0; k < stewardTokenCount; k++) {
            (uint256 budget,,) = IArmadaTreasuryOutflow(treasury_).getStewardBudget(stewardTokens[k]);
            if (stewardSums[k] > budget) revert Gov_StewardBudgetInfeasible();
        }
    }

    /// @dev Revert if any action would call timelock.updateDelay(X) with X > MAX_EXECUTION_DELAY.
    ///      Setting _minDelay above the governor's max per-proposal executionDelay permanently
    ///      bricks queue() (OZ TimelockController._schedule requires delay >= getMinDelay).
    ///      Malformed calldata (< 4B selector, or < 36B = selector + uint256) is skipped;
    ///      it would revert later at the timelock anyway and is not a minDelay escalation.
    function _validateTimelockCalldata(address[] memory targets, bytes[] memory calldatas) internal view {
        // Hoist timelock address out of the loop (audit-76).
        address tl = address(timelock);
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] != tl) continue;
            if (calldatas[i].length < 36) continue;
            if (bytes4(calldatas[i]) != UPDATE_DELAY_SELECTOR) continue;

            // Decode the uint256 argument. Skip the 4-byte selector by slicing from index 4.
            bytes memory params = new bytes(calldatas[i].length - 4);
            for (uint256 j = 0; j < params.length; j++) {
                params[j] = calldatas[i][j + 4];
            }
            uint256 newDelay = abi.decode(params, (uint256));
            if (newDelay > MAX_EXECUTION_DELAY) {
                revert Gov_UpdateDelayExceedsCap(newDelay, MAX_EXECUTION_DELAY);
            }
        }
    }

    /// @dev Block proposals during the quiet period after crowdfund finalization.
    ///      Reads finalizedAt from the crowdfund contract. Skips gracefully if no
    ///      crowdfund is registered or crowdfund isn't finalized.
    function _checkQuietPeriod() internal view {
        // Cache crowdfundAddress: read twice (audit-76).
        address cf = crowdfundAddress;
        if (cf == address(0)) return;

        uint256 _finalizedAt = IArmadaCrowdfundReadable(cf).finalizedAt();
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
