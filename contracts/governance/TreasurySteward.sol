// ABOUTME: Treasury steward identity management contract (election, term tracking, removal).
// ABOUTME: Steward proposals flow through ArmadaGovernor as pass-by-default governance proposals.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./IArmadaGovernance.sol";

/// @title TreasurySteward — Steward identity management
/// @notice Steward is elected via governance (Extended proposal). The steward submits
///         spending proposals through ArmadaGovernor.proposeStewardSpend(), which creates
///         pass-by-default governance proposals. This contract tracks steward identity only:
///         election, term duration, removal, and active status.
contract TreasurySteward {

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
    constructor(address _timelock) {
        require(_timelock != address(0), "TreasurySteward: zero timelock");
        timelock = _timelock;
    }

    // ============ Governance Functions (via timelock) ============

    /// @notice Elect a new steward (called by timelock after governance proposal)
    function electSteward(address _steward) external onlyTimelock {
        require(_steward != address(0), "TreasurySteward: zero address");
        currentSteward = _steward;
        // Use block.timestamp directly in the emit instead of re-SLOADing termStart (audit-76).
        termStart = block.timestamp;
        emit StewardElected(_steward, block.timestamp, block.timestamp + TERM_DURATION);
    }

    /// @notice Remove the current steward (called by timelock after governance proposal)
    /// @dev Clears both currentSteward and termStart. isStewardActive and termEnd both
    ///      short-circuit on currentSteward == address(0) today, but clearing termStart
    ///      defends against future readers that consume it without the address guard.
    function removeSteward() external onlyTimelock {
        emit StewardRemoved(currentSteward);
        currentSteward = address(0);
        delete termStart;
    }

    // ============ View Functions ============

    function isStewardActive() external view returns (bool) {
        return currentSteward != address(0) && block.timestamp < termStart + TERM_DURATION;
    }

    /// @notice Combined accessor for the active-steward state. Callers that need both
    ///         the address and the active flag (e.g. ArmadaGovernor's steward-proposal
    ///         gates) should use this to avoid a second external call and a duplicate
    ///         currentSteward SLOAD inside isStewardActive(). Returns the elected
    ///         address (or zero if none) and whether they are within the active term.
    function getCurrentSteward() external view returns (address steward, bool isActive) {
        steward = currentSteward;
        isActive = steward != address(0) && block.timestamp < termStart + TERM_DURATION;
    }

    function termEnd() external view returns (uint256) {
        if (currentSteward == address(0)) return 0;
        return termStart + TERM_DURATION;
    }
}
