// SPDX-License-Identifier: MIT
// ABOUTME: Interface for the centralized fee oracle that calculates shield fees and tracks revenue.
// ABOUTME: Supports volume-tiered Armada take, integrator fees, yield fee reporting, and IFeeCollector.
pragma solidity ^0.8.17;

import "../governance/IFeeCollector.sol";

/// @title IArmadaFeeModule — Centralized fee oracle for shield and yield fees
/// @notice Calculates fee rates, tracks integrator volume/earnings, and exposes cumulative
///         protocol revenue via IFeeCollector for RevenueCounter integration.
interface IArmadaFeeModule is IFeeCollector {

    // ══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Volume tier: when an integrator's cumulative volume exceeds the threshold,
    ///         the Armada take drops to the specified bps.
    struct Tier {
        uint256 volumeThreshold;
        uint256 armadaTakeBps;
    }

    /// @notice Per-integrator registration and cumulative stats.
    struct IntegratorInfo {
        uint256 baseFee;
        uint256 cumulativeVolume;
        uint256 cumulativeEarnings;
        bool registered;
    }

    /// @notice Governance-assigned custom terms for a specific integrator.
    struct CustomTerms {
        uint256 customArmadaTakeBps;
        uint256 customVolumeThreshold;
        bool active;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ══════════════════════════════════════════════════════════════════════════

    event IntegratorRegistered(address indexed integrator, uint256 baseFee);
    event ShieldFeeRecorded(address indexed integrator, uint256 amount, uint256 armadaTake, uint256 integratorFee);
    event YieldFeeRecorded(uint256 amount);
    event BaseArmadaTakeUpdated(uint256 oldBps, uint256 newBps);
    event TierAdded(uint256 index, uint256 volumeThreshold, uint256 armadaTakeBps);
    event TierUpdated(uint256 index, uint256 volumeThreshold, uint256 armadaTakeBps);
    event TierRemoved(uint256 index);
    event YieldFeeUpdated(uint256 oldBps, uint256 newBps);
    event IntegratorTermsSet(address indexed integrator, uint256 takeBps, uint256 threshold, bool active);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event PrivacyPoolUpdated(address indexed oldPool, address indexed newPool);
    event YieldVaultUpdated(address indexed oldVault, address indexed newVault);

    // ══════════════════════════════════════════════════════════════════════════
    // FEE CALCULATION (VIEW)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Calculate shield fee breakdown for a given integrator and amount.
    /// @param integrator Integrator address (address(0) for no integrator)
    /// @param amount Gross shield amount (inclusive — fees deducted from this)
    /// @return armadaTake Protocol fee portion
    /// @return integratorFee Integrator fee portion
    /// @return totalFee armadaTake + integratorFee
    function calculateShieldFee(
        address integrator,
        uint256 amount
    ) external view returns (uint256 armadaTake, uint256 integratorFee, uint256 totalFee);

    /// @notice Returns the current yield fee rate in basis points.
    function getYieldFeeBps() external view returns (uint256);

    // ══════════════════════════════════════════════════════════════════════════
    // FEE RECORDING (AUTHORIZED CALLERS)
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Record a shield fee after payment. Called by PrivacyPool only.
    /// @param integrator Integrator address (address(0) for no integrator)
    /// @param amount Gross shield amount
    /// @param armadaTakePaid Armada protocol fee actually paid
    /// @param integratorFeePaid Integrator fee actually paid
    function recordShieldFee(
        address integrator,
        uint256 amount,
        uint256 armadaTakePaid,
        uint256 integratorFeePaid
    ) external;

    /// @notice Record a yield fee after payment. Called by ArmadaYieldVault only.
    /// @param amount Yield fee amount paid to treasury
    function recordYieldFee(uint256 amount) external;

    // ══════════════════════════════════════════════════════════════════════════
    // INTEGRATOR SELF-SERVICE
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Register as an integrator or update base fee. Permissionless.
    /// @param feeBps Base fee in basis points charged to users via this integrator
    function setIntegratorFee(uint256 feeBps) external;

    // ══════════════════════════════════════════════════════════════════════════
    // GOVERNANCE SETTERS
    // ══════════════════════════════════════════════════════════════════════════

    function setBaseArmadaTake(uint256 bps) external;
    function addTier(uint256 threshold, uint256 takeBps) external;
    function setTier(uint256 index, uint256 threshold, uint256 takeBps) external;
    function removeTier(uint256 index) external;
    function setYieldFee(uint256 bps) external;
    function setIntegratorTerms(address integrator, uint256 takeBps, uint256 threshold, bool active) external;
    function setTreasury(address _treasury) external;
    function setPrivacyPool(address _privacyPool) external;
    function setYieldVault(address _yieldVault) external;

    // ══════════════════════════════════════════════════════════════════════════
    // QUERY VIEWS
    // ══════════════════════════════════════════════════════════════════════════

    function baseArmadaTakeBps() external view returns (uint256);
    function yieldFeeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function privacyPool() external view returns (address);
    function yieldVault() external view returns (address);
    function cumulativeArmadaFees() external view returns (uint256);
    function cumulativeIntegratorFees() external view returns (uint256);

    function getIntegratorInfo(address integrator) external view returns (IntegratorInfo memory);
    function getIntegratorTerms(address integrator) external view returns (CustomTerms memory);
    function getTiers() external view returns (Tier[] memory);
    function getTierCount() external view returns (uint256);

    /// @notice Get the effective Armada take for a given integrator (considers volume + custom terms).
    function getArmadaTake(address integrator) external view returns (uint256);

    /// @notice Get the total user-facing fee for a given integrator (armada take + integrator base + bonus).
    function getUserFee(address integrator) external view returns (uint256);

    /// @notice Get the bonus bps an integrator earns from volume tier discounts.
    function getIntegratorBonus(address integrator) external view returns (uint256);
}
