// ABOUTME: Upgradeable base contract providing emergency pause with auto-expiry and guardian role.
// ABOUTME: Companion to EmergencyPausable.sol for UUPS-upgradeable contracts (e.g. ArmadaGovernor).

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title EmergencyPausableUpgradeable — Time-limited emergency pause with guardian role (upgradeable)
/// @notice Provides a guardian-triggered pause that auto-expires after a configurable duration.
///         Governance (the timelock) can always unpause early and rotate the guardian.
///         The guardian cannot permanently freeze the system — the pause always expires.
///         Implements pause logic directly (not extending OZ Pausable) because auto-expiry
///         requires the internal pause flag and paused() to stay in sync, which OZ Pausable's
///         private _paused flag prevents.
abstract contract EmergencyPausableUpgradeable is Initializable {

    // ============ State ============

    /// @notice Whether the contract is currently in a paused state (internal flag)
    bool private _paused;

    /// @notice Address authorized to trigger emergency pause
    address public guardian;

    /// @notice Timestamp when the current pause expires (0 if not paused)
    uint256 public pauseExpiry;

    /// @notice Maximum duration a pause can last
    uint256 public maxPauseDuration;

    /// @notice Timelock address (governance authority for unpause and guardian rotation)
    address public pauseTimelock;

    // ============ Events ============

    event EmergencyPaused(address indexed guardian, uint256 expiry);
    event EmergencyUnpaused(address indexed caller);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);

    // ============ Initializer ============

    /// @param _guardian Initial guardian address
    /// @param _maxPauseDuration Maximum pause duration in seconds
    /// @param _pauseTimelock Timelock address (governance) that can unpause and set guardian
    function __EmergencyPausable_init(
        address _guardian,
        uint256 _maxPauseDuration,
        address _pauseTimelock
    ) internal onlyInitializing {
        require(_guardian != address(0), "EmergencyPausable: zero guardian");
        require(_maxPauseDuration > 0, "EmergencyPausable: zero duration");
        require(_pauseTimelock != address(0), "EmergencyPausable: zero timelock");

        guardian = _guardian;
        maxPauseDuration = _maxPauseDuration;
        pauseTimelock = _pauseTimelock;
    }

    // ============ Modifiers ============

    modifier onlyGuardian() {
        require(msg.sender == guardian, "EmergencyPausable: not guardian");
        _;
    }

    modifier onlyPauseTimelock() {
        require(msg.sender == pauseTimelock, "EmergencyPausable: not timelock");
        _;
    }

    /// @dev Reverts if the contract is paused (accounting for auto-expiry).
    modifier whenNotPaused() {
        require(!paused(), "Pausable: paused");
        _;
    }

    // ============ View Functions ============

    /// @notice Returns true only if paused AND the pause has not expired
    function paused() public view virtual returns (bool) {
        return _paused && block.timestamp < pauseExpiry;
    }

    // ============ Guardian Functions ============

    /// @notice Guardian triggers emergency pause. Auto-expires after maxPauseDuration.
    function emergencyPause() external onlyGuardian {
        require(!paused(), "EmergencyPausable: already paused");
        _paused = true;
        pauseExpiry = block.timestamp + maxPauseDuration;
        emit EmergencyPaused(msg.sender, pauseExpiry);
    }

    // ============ Governance Functions ============

    /// @notice Governance (timelock) can unpause at any time
    function emergencyUnpause() external onlyPauseTimelock {
        require(paused(), "EmergencyPausable: not paused");
        _paused = false;
        pauseExpiry = 0;
        emit EmergencyUnpaused(msg.sender);
    }

    /// @notice Governance (timelock) can rotate the guardian
    function setGuardian(address _guardian) external onlyPauseTimelock {
        require(_guardian != address(0), "EmergencyPausable: zero guardian");
        emit GuardianUpdated(guardian, _guardian);
        guardian = _guardian;
    }

    // ============ Storage Gap ============

    /// @dev Reserved storage for future upgrades. 5 slots used above, 45 reserved = 50 total.
    uint256[45] private __gap;
}
