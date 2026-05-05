// SPDX-License-Identifier: MIT
// ABOUTME: Wind-down contract with permissionless trigger and governance trigger.
// ABOUTME: Sweeps treasury assets to redemption contract; enables ARM transfers; disables governance.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Minimal interfaces for cross-contract calls during wind-down
interface IArmadaTokenWindDown {
    function setTransferable(bool _transferable) external;
    function transferable() external view returns (bool);
}

interface IArmadaGovernorWindDown {
    function setWindDownActive() external;
}

interface IShieldPauseControllerWindDown {
    function setWindDownActive() external;
}

interface IRevenueCounterWindDown {
    function recognizedRevenueUsd() external view returns (uint256);
    function freeze() external;
    function syncStablecoinRevenue() external;
}

interface IRevenueLockWindDown {
    function freezeAtWindDown() external;
}

interface ITreasuryWindDown {
    function transferTo(address token, address recipient, uint256 amount) external;
    function transferETHTo(address payable recipient, uint256 amount) external;
}

/// @title ArmadaWindDown — Protocol wind-down trigger and treasury sweep
/// @notice Not upgradeable. Trigger logic is immutable. Only parameters are governable.
///
///         Two trigger paths:
///         1. Permissionless: Anyone can trigger if deadline has passed AND revenue is below threshold.
///         2. Governance: Timelock can trigger at any time regardless of conditions.
///
///         On trigger:
///         - ARM transfers are enabled (via setTransferable on token)
///         - Governance is permanently disabled (via setWindDownActive on governor)
///         - Shield pause enters post-wind-down mode (single-pause only)
///
///         After trigger, anyone can sweep treasury assets to the redemption contract.
///         ARM cannot be swept — treasury ARM is locked permanently.
contract ArmadaWindDown {

    // ============ Immutable References ============

    /// @notice ARM governance token
    address public immutable armToken;

    /// @notice Treasury contract
    ITreasuryWindDown public immutable treasury;

    /// @notice Governor contract
    IArmadaGovernorWindDown public immutable governor;

    /// @notice Redemption contract (receives swept assets)
    address public immutable redemptionContract;

    /// @notice Shield pause controller
    IShieldPauseControllerWindDown public immutable pauseContract;

    /// @notice Revenue counter (reads cumulative recognized revenue, frozen at trigger)
    IRevenueCounterWindDown public immutable revenueCounter;

    /// @notice Revenue lock (frozen at trigger so circulatingSupply is stable)
    IRevenueLockWindDown public immutable revenueLock;

    /// @notice Timelock address (governance authority for direct trigger and parameter changes)
    address public immutable timelock;

    // ============ Governable Parameters ============

    /// @notice Revenue threshold for permissionless trigger (in 18-decimal USD)
    uint256 public revenueThreshold;

    /// @notice Deadline for permissionless trigger (unix timestamp)
    uint256 public windDownDeadline;

    // ============ State ============

    /// @notice Whether wind-down has been triggered
    bool public triggered;

    /// @notice Timestamp at which wind-down was triggered. Zero before trigger.
    ///         Consumed by ArmadaRedemption to enforce a post-trigger delay before
    ///         redemptions can begin, giving time for sweepToken/sweepETH to run.
    uint256 public triggerTime;

    // ============ Events ============

    event WindDownTriggered(address indexed caller, uint256 timestamp, bool governanceForced);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);
    event ETHSwept(address indexed recipient, uint256 amount);
    event RevenueThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event WindDownDeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    // ============ Constructor ============

    /// @param _armToken ARM token address
    /// @param _treasury Treasury contract address
    /// @param _governor Governor contract address
    /// @param _redemptionContract Redemption contract address (receives swept assets)
    /// @param _pauseContract Shield pause controller address
    /// @param _revenueCounter Revenue counter address
    /// @param _timelock Timelock address (governance authority)
    /// @param _revenueThreshold Initial revenue threshold (18-decimal USD)
    /// @param _windDownDeadline Initial deadline (unix timestamp)
    constructor(
        address _armToken,
        address _treasury,
        address _governor,
        address _redemptionContract,
        address _pauseContract,
        address _revenueCounter,
        address _revenueLock,
        address _timelock,
        uint256 _revenueThreshold,
        uint256 _windDownDeadline
    ) {
        require(_armToken != address(0), "ArmadaWindDown: zero armToken");
        require(_treasury != address(0), "ArmadaWindDown: zero treasury");
        require(_governor != address(0), "ArmadaWindDown: zero governor");
        require(_redemptionContract != address(0), "ArmadaWindDown: zero redemption");
        require(_pauseContract != address(0), "ArmadaWindDown: zero pauseContract");
        require(_revenueCounter != address(0), "ArmadaWindDown: zero revenueCounter");
        require(_revenueLock != address(0), "ArmadaWindDown: zero revenueLock");
        require(_timelock != address(0), "ArmadaWindDown: zero timelock");
        require(_windDownDeadline > block.timestamp, "ArmadaWindDown: deadline in past");
        require(_revenueThreshold > 0, "ArmadaWindDown: zero threshold");

        armToken = _armToken;
        treasury = ITreasuryWindDown(_treasury);
        governor = IArmadaGovernorWindDown(_governor);
        redemptionContract = _redemptionContract;
        pauseContract = IShieldPauseControllerWindDown(_pauseContract);
        revenueCounter = IRevenueCounterWindDown(_revenueCounter);
        revenueLock = IRevenueLockWindDown(_revenueLock);
        timelock = _timelock;
        revenueThreshold = _revenueThreshold;
        windDownDeadline = _windDownDeadline;
    }

    // ============ Trigger Functions ============

    /// @notice Permissionless wind-down trigger. Anyone can call if both conditions are met:
    ///         1. Current time is past the wind-down deadline
    ///         2. Cumulative recognized revenue is below the threshold
    function triggerWindDown() external {
        require(!triggered, "ArmadaWindDown: already triggered");
        require(block.timestamp > windDownDeadline, "ArmadaWindDown: deadline not passed");

        // Best-effort sync from the fee collector before reading the threshold.
        // Without this, a stale recognizedRevenueUsd could let wind-down trigger
        // when the actual fee balance is already above threshold (no one called
        // syncStablecoinRevenue recently). Wrapped in try/catch so wind-down stays
        // permissionless even if sync reverts (no fee collector configured, fee
        // collector itself reverts, etc.) — the threshold check then runs against
        // whatever value the counter currently has.
        try revenueCounter.syncStablecoinRevenue() {} catch {}

        require(
            revenueCounter.recognizedRevenueUsd() < revenueThreshold,
            "ArmadaWindDown: revenue meets threshold"
        );
        _executeWindDown(false);
    }

    /// @notice Governance trigger. Timelock can trigger at any time, no conditions required.
    function governanceTriggerWindDown() external {
        require(msg.sender == timelock, "ArmadaWindDown: not timelock");
        require(!triggered, "ArmadaWindDown: already triggered");
        _executeWindDown(true);
    }

    // ============ Sweep Functions ============

    /// @notice Sweep an ERC20 token from treasury to redemption contract.
    ///         Permissionless after trigger. ARM cannot be swept.
    /// @param token ERC20 token to sweep
    function sweepToken(address token) external {
        require(triggered, "ArmadaWindDown: not triggered");
        require(token != armToken, "ArmadaWindDown: cannot sweep ARM");
        uint256 balance = IERC20(token).balanceOf(address(treasury));
        require(balance > 0, "ArmadaWindDown: no balance");
        treasury.transferTo(token, redemptionContract, balance);
        emit TokenSwept(token, redemptionContract, balance);
    }

    /// @notice Sweep ETH from treasury to redemption contract.
    ///         Permissionless after trigger.
    function sweepETH() external {
        require(triggered, "ArmadaWindDown: not triggered");
        uint256 balance = address(treasury).balance;
        require(balance > 0, "ArmadaWindDown: no balance");
        treasury.transferETHTo(payable(redemptionContract), balance);
        emit ETHSwept(redemptionContract, balance);
    }

    // ============ Parameter Setters (Governance) ============

    /// @notice Update the revenue threshold. Timelock-only. Cannot change after trigger.
    ///         Threshold must be > 0 to prevent governance from disabling the permissionless
    ///         trigger (setting 0 would make `recognizedRevenue < 0` always false for uint256).
    function setRevenueThreshold(uint256 _newThreshold) external {
        require(msg.sender == timelock, "ArmadaWindDown: not timelock");
        // Parameter check before cold SLOAD on `triggered` (audit-79).
        require(_newThreshold > 0, "ArmadaWindDown: zero threshold");
        require(!triggered, "ArmadaWindDown: already triggered");
        emit RevenueThresholdUpdated(revenueThreshold, _newThreshold);
        revenueThreshold = _newThreshold;
    }

    /// @notice Update the wind-down deadline. Timelock-only. Cannot change after trigger.
    ///         Deadline must be in the future (same invariant the constructor enforces) to
    ///         prevent governance from disabling the permissionless trigger.
    ///         DESIGN NOTE: Governance can repeatedly extend the deadline. No hard cap is
    ///         imposed because protocol lifetime is uncertain and an artificial cap could
    ///         force unnecessary wind-down. Capture attempts are mitigated by the Security
    ///         Council veto on any queued proposal. The selector is currently classified as
    ///         Standard (20% quorum, 7-day vote, 2-day execution delay); extending the
    ///         deadline is a loosening action that should eventually sit at the Extended
    ///         bar per the asymmetric governance principle.
    // TODO: Raise setWindDownDeadline to Extended for the extend-direction once the
    // governor enforces directional classification (see ArmadaGovernor._initializeSelectors
    // comment above the standard setWindDownDeadline registration).
    function setWindDownDeadline(uint256 _newDeadline) external {
        require(msg.sender == timelock, "ArmadaWindDown: not timelock");
        // Parameter check before cold SLOAD on `triggered` (audit-79).
        require(_newDeadline > block.timestamp, "ArmadaWindDown: deadline in past");
        require(!triggered, "ArmadaWindDown: already triggered");
        emit WindDownDeadlineUpdated(windDownDeadline, _newDeadline);
        windDownDeadline = _newDeadline;
    }

    // ============ Internal ============

    function _executeWindDown(bool governanceForced) internal {
        triggered = true;
        triggerTime = block.timestamp;

        // Freeze the revenue counter FIRST so that the RevenueLock final-ratchet-update
        // below reads a stable upstream value. After freeze, no further attestRevenue
        // or syncStablecoinRevenue can advance the counter — the unlock-percentage
        // milestone state at trigger time becomes the permanent fixed point.
        revenueCounter.freeze();

        // Then freeze the RevenueLock ratchet. freezeAtWindDown performs one final
        // _updateMaxObservedRevenue against the (just frozen) counter and locks
        // maxObservedRevenue. After this, ArmadaRedemption.lockedAtWindDown returns
        // a stable value across the redemption window.
        revenueLock.freezeAtWindDown();

        // Enable ARM transfers (users need to move ARM to redeem). The post-condition
        // is "transfers are enabled" — not "transfers were flipped here". Governance
        // can independently enable transfers via a separate proposal, so we only call
        // setTransferable when needed; the token's setter reverts on already-enabled.
        if (!IArmadaTokenWindDown(armToken).transferable()) {
            IArmadaTokenWindDown(armToken).setTransferable(true);
        }

        // Permanently disable governance (no new proposals)
        governor.setWindDownActive();

        // Activate post-wind-down pause restrictions (single-pause only)
        pauseContract.setWindDownActive();

        emit WindDownTriggered(msg.sender, block.timestamp, governanceForced);
    }
}
