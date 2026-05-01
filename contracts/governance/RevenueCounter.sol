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

    /// @notice Wind-down contract authorized to freeze the counter at trigger time.
    ///         Set once via setWindDownContract.
    address public windDownContract;
    /// @notice One-time setter lock for windDownContract.
    bool public windDownContractSet;

    /// @notice Whether the counter is permanently frozen. Set by the wind-down
    ///         contract at trigger time. Once frozen, recognizedRevenueUsd cannot
    ///         change — attestRevenue and syncStablecoinRevenue revert. Stabilizes
    ///         the redemption denominator across the post-wind-down redemption window.
    bool public frozen;

    // ============ Events ============

    event RevenueUpdated(uint256 cumulativeRevenue, uint256 previousRevenue);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event WindDownContractSet(address indexed windDownContract);
    event Frozen(uint256 frozenAt);

    // ============ Constructor ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /// @param _owner The governance address (timelock) that owns this contract.
    function initialize(address _owner) external initializer {
        require(_owner != address(0), "RevenueCounter: zero owner");
        __Ownable_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_owner);
    }

    // ============ Permissionless Sync ============

    /// @notice Sync revenue from the fee collector. Anyone can call this.
    /// @dev Reads cumulativeFeesCollected() from the fee collector, computes the delta
    ///      since the last sync, scales USDC (6 decimals) to USD (18 decimals), and adds
    ///      to the cumulative counter.
    ///
    ///      Defense-in-depth: if the fee collector reports a value below
    ///      lastSyncedCumulative (only reachable via collector replacement or
    ///      storage corruption — the live ArmadaFeeModule is monotonic by
    ///      construction), the recognizedRevenueUsd counter is left unchanged
    ///      (it is monotonic by spec) and lastSyncedCumulative is advanced to
    ///      the collector's current view so future legitimate increments are
    ///      captured from the new baseline. Without this guard, a regressed
    ///      collector would brick all permissionless syncs and the
    ///      setFeeCollector recovery path via 0.8.x subtraction underflow.
    function syncStablecoinRevenue() external {
        require(!frozen, "RevenueCounter: frozen");
        require(feeCollector != address(0), "RevenueCounter: no fee collector");

        uint256 currentCumulative = IFeeCollector(feeCollector).cumulativeFeesCollected();
        if (currentCumulative == lastSyncedCumulative) return; // no new fees (common path)

        if (currentCumulative < lastSyncedCumulative) {
            // Collector regression — track the new baseline; recognized counter unchanged.
            lastSyncedCumulative = currentCumulative;
            return;
        }

        uint256 delta = currentCumulative - lastSyncedCumulative;
        lastSyncedCumulative = currentCumulative;

        uint256 previousRevenue = recognizedRevenueUsd;
        recognizedRevenueUsd += delta * USDC_TO_USD_SCALE;

        emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
    }

    // ============ Governance Functions ============

    /// @notice Increment cumulative revenue by deltaUsd. Governance-only (timelock).
    ///         Routine path for non-stablecoin revenue attestation (ETH, etc.).
    ///
    ///         Increment semantics are commutative with concurrent permissionless
    ///         syncStablecoinRevenue() calls during the proposal's lifecycle —
    ///         stable accrual that lands between proposal creation and execution
    ///         is preserved, not overwritten. Use this in preference to
    ///         attestRevenue for routine non-stable attestations.
    /// @param deltaUsd Amount of new revenue to credit, in 18-decimal USD.
    function addRevenue(uint256 deltaUsd) external onlyOwner {
        require(!frozen, "RevenueCounter: frozen");
        if (deltaUsd == 0) return; // no-op

        uint256 previousRevenue = recognizedRevenueUsd;
        recognizedRevenueUsd = previousRevenue + deltaUsd;

        emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
    }

    /// @notice Attest to a new cumulative revenue value. Governance-only (timelock).
    /// @dev Must be >= current recognizedRevenueUsd (monotonic). Same value is a no-op.
    ///
    ///      Reserved for confirmed-error correction (e.g. snapping the counter to a
    ///      known cumulative total after an audit reconciliation). NOT for routine
    ///      non-stable revenue attestation — use addRevenue for that.
    ///
    ///      HAZARD: SET semantics race against permissionless syncStablecoinRevenue
    ///      during the proposal lifecycle. Any stable accrual synced between
    ///      proposal creation and execution is silently overwritten by this call,
    ///      and is NOT re-credited by future syncs (lastSyncedCumulative is
    ///      unchanged here, so future delta computation flows above the stale
    ///      baseline). Avoid for routine ops; addRevenue is the safe path.
    /// @param newCumulativeUsd New cumulative revenue in 18-decimal USD.
    function attestRevenue(uint256 newCumulativeUsd) external onlyOwner {
        require(!frozen, "RevenueCounter: frozen");
        require(newCumulativeUsd >= recognizedRevenueUsd, "RevenueCounter: not monotonic");

        if (newCumulativeUsd == recognizedRevenueUsd) return; // no-op

        uint256 previousRevenue = recognizedRevenueUsd;
        recognizedRevenueUsd = newCumulativeUsd;

        emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
    }

    /// @notice Set the fee collector address. Governance-only (timelock).
    /// @dev Syncs any pending revenue from the old collector before switching, so that
    ///      accumulated fees are not silently dropped. Then resets lastSyncedCumulative
    ///      to the new collector's current value for correct delta computation.
    /// @param _feeCollector Address of a contract implementing IFeeCollector, or address(0) to clear.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        // Sync pending revenue from the old collector before switching.
        // Saturate delta to zero on regression so a misbehaving old collector
        // does not block its own replacement (this function IS the recovery
        // path). recognizedRevenueUsd is monotonic by spec — never decreased.
        // lastSyncedCumulative is reset to the new collector's value below
        // regardless, so we don't update it here.
        if (feeCollector != address(0)) {
            uint256 currentCumulative = IFeeCollector(feeCollector).cumulativeFeesCollected();
            if (currentCumulative > lastSyncedCumulative) {
                uint256 delta = currentCumulative - lastSyncedCumulative;
                uint256 previousRevenue = recognizedRevenueUsd;
                recognizedRevenueUsd += delta * USDC_TO_USD_SCALE;
                emit RevenueUpdated(recognizedRevenueUsd, previousRevenue);
            }
        }

        emit FeeCollectorUpdated(feeCollector, _feeCollector);
        feeCollector = _feeCollector;
        if (_feeCollector != address(0)) {
            lastSyncedCumulative = IFeeCollector(_feeCollector).cumulativeFeesCollected();
        } else {
            lastSyncedCumulative = 0;
        }
    }

    // ============ Wind-Down ============

    /// @notice Register the wind-down contract. One-shot setter; locks after the
    ///         first non-zero call. Permissionless because the lock + zero-address
    ///         checks make a misregistration recoverable only via UUPS upgrade.
    /// @param _windDownContract The wind-down contract authorized to call freeze().
    function setWindDownContract(address _windDownContract) external {
        require(!windDownContractSet, "RevenueCounter: wind-down already set");
        require(_windDownContract != address(0), "RevenueCounter: zero address");
        windDownContractSet = true;
        windDownContract = _windDownContract;
        emit WindDownContractSet(_windDownContract);
    }

    /// @notice Permanently freeze the counter at its current value. Wind-down only.
    /// @dev Stops attestRevenue and syncStablecoinRevenue. Stabilizes the redemption
    ///      denominator across the post-wind-down redemption window so claim/release
    ///      timing cannot shift the unlock-percentage milestone state mid-redemption.
    function freeze() external {
        require(msg.sender == windDownContract, "RevenueCounter: not wind-down");
        require(!frozen, "RevenueCounter: already frozen");
        frozen = true;
        emit Frozen(recognizedRevenueUsd);
    }

    // ============ UUPS ============

    /// @dev Only the owner (timelock) can authorize upgrades.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ============ Storage Gap ============

    /// @dev Reserved storage for future upgrades. 5 state slots + 45 gap = 50 total.
    ///      Matches the 50-slot reservation convention used by ArmadaGovernor. The
    ///      project deploys via raw ERC1967Proxy (no OZ upgrades-plugin layout-diff
    ///      tooling), so this gap is the only line of defense against a future upgrade
    ///      that adds state above lastSyncedCumulative silently shifting that slot.
    uint256[45] private __gap;
}
