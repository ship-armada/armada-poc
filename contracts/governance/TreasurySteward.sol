// ABOUTME: Treasury steward identity management contract (election, term tracking, removal).
// ABOUTME: Steward proposals flow through ArmadaGovernor as pass-by-default governance proposals.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./IArmadaGovernance.sol";
import "./EmergencyPausable.sol";

/// @title TreasurySteward — Steward identity management
/// @notice Steward is elected via governance (Extended proposal). The steward submits
///         spending proposals through ArmadaGovernor.proposeStewardAction(), which creates
///         pass-by-default governance proposals. This contract tracks steward identity only:
///         election, term duration, removal, and active status.
contract TreasurySteward is EmergencyPausable {

    // ============ State ============

    address public immutable timelock;     // TimelockController address (governance-controlled)
    address public currentSteward;

    uint256 public termStart;
    uint256 public constant TERM_DURATION = 180 days; // 6-month term

    // ============ Events ============

    event StewardElected(address indexed steward, uint256 termStart, uint256 termEnd);
    event StewardRemoved(address indexed steward);

    // ============ Modifiers ============

    modifier onlyTimelock() {
        require(msg.sender == timelock, "TreasurySteward: not timelock");
        _;
    }

    // ============ Constructor ============

    /// @param _timelock TimelockController address
    /// @param _guardian Emergency pause guardian address
    /// @param _maxPauseDuration Maximum duration of emergency pause in seconds
    constructor(
        address _timelock,
        address _guardian,
        uint256 _maxPauseDuration
    ) EmergencyPausable(_guardian, _maxPauseDuration, _timelock) {
        require(_timelock != address(0), "TreasurySteward: zero timelock");
        timelock = _timelock;
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

    // ============ View Functions ============

    function isStewardActive() external view returns (bool) {
        return currentSteward != address(0) && block.timestamp < termStart + TERM_DURATION;
    }

    function termEnd() external view returns (uint256) {
        if (currentSteward == address(0)) return 0;
        return termStart + TERM_DURATION;
    }
}
