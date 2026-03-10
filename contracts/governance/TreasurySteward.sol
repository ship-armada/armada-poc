// ABOUTME: Treasury steward contract with action queue, veto mechanism, and target whitelist.
// ABOUTME: Steward proposes actions targeting whitelisted contracts; governance can veto before execution.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./IArmadaGovernance.sol";

/// @title TreasurySteward — Elected steward with action queue and veto mechanism
/// @notice Steward is elected via governance (StewardElection proposal). Has limited powers:
///         can propose and execute actions on whitelisted target contracts, but tokenholders
///         can veto actions via governance proposals before they are executed.
///         The action delay is enforced to be >= 120% of the fastest governance veto cycle,
///         ensuring governance always has time to veto before execution.
contract TreasurySteward is ReentrancyGuard {

    // ============ Constants ============

    /// @notice Safety margin for action delay over governance cycle (120% = 12000 bps)
    uint256 private constant DELAY_SAFETY_MARGIN_BPS = 12000;
    uint256 private constant BPS_DENOMINATOR = 10000;

    // ============ State ============

    address public immutable timelock;     // TimelockController address (governance-controlled)
    address public immutable treasury;     // ArmadaTreasuryGov address
    address public immutable governor;     // ArmadaGovernor address (for timing params)
    address public currentSteward;

    uint256 public termStart;
    uint256 public constant TERM_DURATION = 180 days; // 6-month term

    // Steward action queue
    uint256 public actionCount;
    mapping(uint256 => StewardAction) public actions;

    // Configurable delay for steward actions (veto window)
    uint256 public actionDelay;

    // Target whitelist — only whitelisted addresses can be called by steward actions
    mapping(address => bool) public allowedTargets;

    // ============ Events ============

    event StewardElected(address indexed steward, uint256 termStart, uint256 termEnd);
    event StewardRemoved(address indexed steward);
    event ActionProposed(uint256 indexed actionId, address indexed target, uint256 value, uint256 executeAfter);
    event ActionExecuted(uint256 indexed actionId);
    event ActionVetoed(uint256 indexed actionId);
    event ActionDelayUpdated(uint256 oldDelay, uint256 newDelay);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);

    // ============ Modifiers ============

    modifier onlyTimelock() {
        require(msg.sender == timelock, "TreasurySteward: not timelock");
        _;
    }

    modifier onlySteward() {
        require(msg.sender == currentSteward, "TreasurySteward: not steward");
        require(block.timestamp < termStart + TERM_DURATION, "TreasurySteward: term expired");
        _;
    }

    // ============ Constructor ============

    /// @param _timelock TimelockController address
    /// @param _treasury ArmadaTreasuryGov address
    /// @param _governor ArmadaGovernor address (used to derive minimum action delay)
    /// @param _actionDelay Delay before steward actions can execute (veto window)
    constructor(address _timelock, address _treasury, address _governor, uint256 _actionDelay) {
        require(_timelock != address(0), "TreasurySteward: zero timelock");
        require(_treasury != address(0), "TreasurySteward: zero treasury");
        require(_governor != address(0), "TreasurySteward: zero governor");
        timelock = _timelock;
        treasury = _treasury;
        governor = _governor;

        uint256 minDelay = minActionDelay();
        require(_actionDelay >= minDelay, "TreasurySteward: delay below governance cycle");
        actionDelay = _actionDelay;

        // Treasury is permanently whitelisted
        allowedTargets[_treasury] = true;
        emit TargetAdded(_treasury);
    }

    // ============ Governance Functions (via timelock) ============

    /// @notice Elect a new steward (called by timelock after governance proposal)
    function electSteward(address _steward) external onlyTimelock {
        require(_steward != address(0), "TreasurySteward: zero address");
        currentSteward = _steward;
        termStart = block.timestamp;
        emit StewardElected(_steward, termStart, termStart + TERM_DURATION);
    }

    /// @notice Remove the current steward (called by timelock after governance proposal)
    function removeSteward() external onlyTimelock {
        emit StewardRemoved(currentSteward);
        currentSteward = address(0);
    }

    /// @notice Veto a steward action (called by timelock after governance proposal)
    function vetoAction(uint256 actionId) external onlyTimelock {
        StewardAction storage action = actions[actionId];
        require(action.id != 0, "TreasurySteward: unknown action");
        require(!action.executed, "TreasurySteward: already executed");
        require(!action.vetoed, "TreasurySteward: already vetoed");

        action.vetoed = true;
        emit ActionVetoed(actionId);
    }

    /// @notice Update the action delay (veto window)
    function setActionDelay(uint256 _actionDelay) external onlyTimelock {
        uint256 minDelay = minActionDelay();
        require(_actionDelay >= minDelay, "TreasurySteward: delay below governance cycle");
        emit ActionDelayUpdated(actionDelay, _actionDelay);
        actionDelay = _actionDelay;
    }

    /// @notice Add a target to the whitelist (called by timelock after governance proposal)
    function addAllowedTarget(address target) external onlyTimelock {
        require(target != address(0), "TreasurySteward: zero target");
        require(!allowedTargets[target], "TreasurySteward: already allowed");
        allowedTargets[target] = true;
        emit TargetAdded(target);
    }

    /// @notice Remove a target from the whitelist (called by timelock after governance proposal)
    /// @dev Treasury cannot be removed — it is permanently whitelisted.
    function removeAllowedTarget(address target) external onlyTimelock {
        require(target != treasury, "TreasurySteward: cannot remove treasury");
        require(allowedTargets[target], "TreasurySteward: not allowed");
        allowedTargets[target] = false;
        emit TargetRemoved(target);
    }

    // ============ Steward Functions ============

    /// @notice Propose a steward action (queued for veto window)
    /// @param target Contract to call (must be whitelisted)
    /// @param data Encoded function call
    /// @param value ETH value to send
    function proposeAction(
        address target,
        bytes calldata data,
        uint256 value
    ) external onlySteward returns (uint256) {
        require(allowedTargets[target], "TreasurySteward: target not allowed");

        uint256 actionId = ++actionCount;
        actions[actionId] = StewardAction({
            id: actionId,
            target: target,
            data: data,
            value: value,
            timestamp: block.timestamp,
            executed: false,
            vetoed: false
        });

        emit ActionProposed(actionId, target, value, block.timestamp + actionDelay);
        return actionId;
    }

    /// @notice Execute a proposed steward action (after delay, if not vetoed)
    function executeAction(uint256 actionId) external onlySteward nonReentrant {
        StewardAction storage action = actions[actionId];
        require(action.id != 0, "TreasurySteward: unknown action");
        require(!action.executed, "TreasurySteward: already executed");
        require(!action.vetoed, "TreasurySteward: vetoed");
        require(allowedTargets[action.target], "TreasurySteward: target not allowed");
        require(
            block.timestamp >= action.timestamp + actionDelay,
            "TreasurySteward: delay not elapsed"
        );

        action.executed = true;

        (bool success, bytes memory returnData) = action.target.call{value: action.value}(action.data);
        if (!success) {
            // Bubble up the original revert data so callers see the real reason
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        emit ActionExecuted(actionId);
    }

    // ============ View Functions ============

    /// @notice Minimum action delay derived from governor timing: 120% of the fastest governance cycle
    /// @dev Fastest cycle is ParameterChange: votingDelay + votingPeriod + executionDelay
    function minActionDelay() public view returns (uint256) {
        (uint256 votingDelay, uint256 votingPeriod, uint256 executionDelay,) =
            IArmadaGovernorTiming(governor).proposalTypeParams(ProposalType.ParameterChange);
        uint256 governanceCycle = votingDelay + votingPeriod + executionDelay;
        return (governanceCycle * DELAY_SAFETY_MARGIN_BPS) / BPS_DENOMINATOR;
    }

    function isStewardActive() external view returns (bool) {
        return currentSteward != address(0) && block.timestamp < termStart + TERM_DURATION;
    }

    function termEnd() external view returns (uint256) {
        if (currentSteward == address(0)) return 0;
        return termStart + TERM_DURATION;
    }

    function getAction(uint256 actionId) external view returns (
        address target,
        uint256 value,
        uint256 timestamp,
        bool executed,
        bool vetoed,
        uint256 executeAfter
    ) {
        StewardAction storage a = actions[actionId];
        return (a.target, a.value, a.timestamp, a.executed, a.vetoed, a.timestamp + actionDelay);
    }
}
