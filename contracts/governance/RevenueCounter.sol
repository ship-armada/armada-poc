// SPDX-License-Identifier: MIT
// ABOUTME: UUPS-upgradeable monotonic revenue counter for cumulative protocol revenue in 18-decimal USD.
// ABOUTME: Revenue enters via permissionless fee collector sync or governance attestation.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./IFeeCollector.sol";

/// @title RevenueCounter — Monotonic cumulative revenue tracker
/// @notice Tracks total recognized protocol revenue in 18-decimal USD.
///         Revenue enters via two paths:
///         1. syncStablecoinRevenue() — permissionless, reads IFeeCollector
///         2. attestRevenue() — governance-only, for off-chain or non-USDC sources
///         Used by downstream systems (wind-down triggers, token unlock gates).
contract RevenueCounter is Initializable, UUPSUpgradeable, OwnableUpgradeable {

    /// @notice Cumulative recognized revenue in 18-decimal USD. Monotonically non-decreasing.
    uint256 public recognizedRevenueUsd;

    /// @notice Address of the fee collector contract that reports cumulative USDC fees.
    address public feeCollector;

    /// @notice Tracks the last cumulative value read from the fee collector,
    ///         so we can compute the delta on each sync.
    uint256 public lastSyncedCumulative;

    /// @notice USDC has 6 decimals; we store revenue in 18 decimals. Scale factor = 1e12.
    uint256 private constant USDC_TO_USD_SCALE = 1e12;

    // ============ Events ============

    event RevenueUpdated(uint256 cumulativeRevenue, uint256 previousRevenue);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);

    // ============ Initializer ============

    /// @param _owner The governance address (timelock) that owns this contract.
    function initialize(address _owner) external initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_owner);
    }

    // ============ Permissionless Sync ============

    /// @notice Sync revenue from the fee collector. Anyone can call this.
    /// @dev Reads cumulativeFeesCollected() from the fee collector, computes the delta
    ///      since the last sync, scales USDC (6 decimals) to USD (18 decimals), and adds
    ///      to the cumulative counter.
    function syncStablecoinRevenue() external {
        require(feeCollector != address(0), "RevenueCounter: no fee collector");

        uint256 currentCumulative = IFeeCollector(feeCollector).cumulativeFeesCollected();
        uint256 delta = currentCumulative - lastSyncedCumulative;

        if (delta == 0) return; // no new fees

        lastSyncedCumulative = currentCumulative;

        uint256 previousRevenue = recognizedRevenueUsd;
        recognizedRevenueUsd += delta * USDC_TO_USD_SCALE;

        emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
    }

    // ============ Governance Functions ============

    /// @notice Attest to a new cumulative revenue value. Governance-only (timelock).
    /// @dev Must be >= current recognizedRevenueUsd (monotonic). Used for off-chain
    ///      revenue sources or corrections. Same value is a no-op.
    /// @param newCumulativeUsd New cumulative revenue in 18-decimal USD.
    function attestRevenue(uint256 newCumulativeUsd) external onlyOwner {
        require(newCumulativeUsd >= recognizedRevenueUsd, "RevenueCounter: not monotonic");

        if (newCumulativeUsd == recognizedRevenueUsd) return; // no-op

        uint256 previousRevenue = recognizedRevenueUsd;
        recognizedRevenueUsd = newCumulativeUsd;

        emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
    }

    /// @notice Set the fee collector address. Governance-only (timelock).
    /// @dev Resets lastSyncedCumulative to the new collector's current value so that
    ///      syncStablecoinRevenue() computes correct deltas from the new baseline.
    /// @param _feeCollector Address of a contract implementing IFeeCollector, or address(0) to clear.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        emit FeeCollectorUpdated(feeCollector, _feeCollector);
        feeCollector = _feeCollector;
        if (_feeCollector != address(0)) {
            lastSyncedCumulative = IFeeCollector(_feeCollector).cumulativeFeesCollected();
        } else {
            lastSyncedCumulative = 0;
        }
    }

    // ============ UUPS ============

    /// @dev Only the owner (timelock) can authorize upgrades.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
