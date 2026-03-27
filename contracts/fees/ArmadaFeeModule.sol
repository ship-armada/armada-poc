// SPDX-License-Identifier: MIT
// ABOUTME: UUPS-upgradeable fee oracle that centralizes shield fee calculation, integrator tracking,
// ABOUTME: and cumulative protocol revenue accounting. Oracle-only — does NOT hold tokens.
pragma solidity ^0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./IArmadaFeeModule.sol";

contract ArmadaFeeModule is Initializable, UUPSUpgradeable, OwnableUpgradeable, IArmadaFeeModule {

    // ══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ══════════════════════════════════════════════════════════════════════════

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_TIERS = 10;
    uint256 public constant MAX_BPS = 1000; // 10% max for any fee component
    uint256 public constant MIN_YIELD_FEE_BPS = 100;  // 1%
    uint256 public constant MAX_YIELD_FEE_BPS = 5000;  // 50%
    uint256 public constant MAX_INTEGRATOR_FEE_BPS = 500; // 5% max integrator base fee

    // ══════════════════════════════════════════════════════════════════════════
    // STORAGE
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Base Armada protocol take in basis points (default 50 = 0.5%)
    uint256 public override baseArmadaTakeBps;

    /// @notice Yield fee in basis points (default 1500 = 15%)
    uint256 public override yieldFeeBps;

    /// @notice Volume tiers (sorted descending by threshold). Max 10.
    Tier[] internal _tiers;

    /// @notice Per-integrator registration and stats
    mapping(address => IntegratorInfo) internal _integrators;

    /// @notice Governance-assigned custom terms for specific integrators
    mapping(address => CustomTerms) internal _customTerms;

    /// @notice Cumulative Armada protocol fees (shield + yield). Monotonically non-decreasing.
    uint256 public override cumulativeArmadaFees;

    /// @notice Cumulative integrator fees (analytics only, not protocol revenue).
    uint256 public override cumulativeIntegratorFees;

    /// @notice Treasury address where protocol fees are sent
    address public override treasury;

    /// @notice Authorized caller for recordShieldFee
    address public override privacyPool;

    /// @notice Authorized caller for recordYieldFee
    address public override yieldVault;

    // ══════════════════════════════════════════════════════════════════════════
    // INITIALIZER
    // ══════════════════════════════════════════════════════════════════════════

    /// @param _owner Governance address (timelock)
    /// @param _treasury ArmadaTreasuryGov address
    /// @param _privacyPool PrivacyPool address (authorized recordShieldFee caller)
    /// @param _yieldVault ArmadaYieldVault address (authorized recordYieldFee caller)
    function initialize(
        address _owner,
        address _treasury,
        address _privacyPool,
        address _yieldVault
    ) external initializer {
        require(_owner != address(0), "ArmadaFeeModule: zero owner");
        require(_treasury != address(0), "ArmadaFeeModule: zero treasury");
        require(_privacyPool != address(0), "ArmadaFeeModule: zero privacyPool");
        require(_yieldVault != address(0), "ArmadaFeeModule: zero yieldVault");

        __Ownable_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_owner);

        treasury = _treasury;
        privacyPool = _privacyPool;
        yieldVault = _yieldVault;

        // Defaults per spec
        baseArmadaTakeBps = 50;    // 0.50%
        yieldFeeBps = 1500;        // 15%

        // Default tier: $250k volume → 40 bps armada take
        _tiers.push(Tier({volumeThreshold: 250_000e6, armadaTakeBps: 40}));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FEE CALCULATION
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IArmadaFeeModule
    function calculateShieldFee(
        address integrator,
        uint256 amount
    ) external view override returns (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) {
        if (amount == 0) return (0, 0, 0);

        uint256 effectiveTakeBps = _getEffectiveArmadaTake(integrator);

        // Inclusive fee: armadaTake = amount * effectiveTakeBps / 10000
        armadaTake = (amount * effectiveTakeBps) / BPS_DENOMINATOR;

        // Integrator fee
        if (integrator != address(0) && _integrators[integrator].registered) {
            uint256 bonus = _getBonus(integrator);
            uint256 integratorTotalBps = _integrators[integrator].baseFee + bonus;
            integratorFee = (amount * integratorTotalBps) / BPS_DENOMINATOR;
        }

        totalFee = armadaTake + integratorFee;
    }

    /// @inheritdoc IArmadaFeeModule
    function getYieldFeeBps() external view override returns (uint256) {
        return yieldFeeBps;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FEE RECORDING
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IArmadaFeeModule
    function recordShieldFee(
        address integrator,
        uint256 amount,
        uint256 armadaTakePaid,
        uint256 integratorFeePaid
    ) external override {
        require(msg.sender == privacyPool, "ArmadaFeeModule: only privacy pool");

        cumulativeArmadaFees += armadaTakePaid;

        if (integrator != address(0) && _integrators[integrator].registered) {
            _integrators[integrator].cumulativeVolume += amount;
            _integrators[integrator].cumulativeEarnings += integratorFeePaid;
            cumulativeIntegratorFees += integratorFeePaid;
        }

        emit ShieldFeeRecorded(integrator, amount, armadaTakePaid, integratorFeePaid);
    }

    /// @inheritdoc IArmadaFeeModule
    function recordYieldFee(uint256 amount) external override {
        require(msg.sender == yieldVault, "ArmadaFeeModule: only yield vault");

        cumulativeArmadaFees += amount;

        emit YieldFeeRecorded(amount);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // IFeeCollector
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFeeCollector
    function cumulativeFeesCollected() external view override returns (uint256) {
        return cumulativeArmadaFees;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTEGRATOR SELF-SERVICE
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IArmadaFeeModule
    function setIntegratorFee(uint256 feeBps) external override {
        require(feeBps <= MAX_INTEGRATOR_FEE_BPS, "ArmadaFeeModule: integrator fee too high");

        IntegratorInfo storage info = _integrators[msg.sender];
        info.baseFee = feeBps;
        info.registered = true;

        emit IntegratorRegistered(msg.sender, feeBps);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // GOVERNANCE SETTERS
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IArmadaFeeModule
    function setBaseArmadaTake(uint256 bps) external override onlyOwner {
        require(bps <= MAX_BPS, "ArmadaFeeModule: take too high");
        emit BaseArmadaTakeUpdated(baseArmadaTakeBps, bps);
        baseArmadaTakeBps = bps;
    }

    /// @inheritdoc IArmadaFeeModule
    function addTier(uint256 threshold, uint256 takeBps) external override onlyOwner {
        require(_tiers.length < MAX_TIERS, "ArmadaFeeModule: max tiers reached");
        require(takeBps <= MAX_BPS, "ArmadaFeeModule: tier take too high");
        require(threshold > 0, "ArmadaFeeModule: zero threshold");

        _tiers.push(Tier({volumeThreshold: threshold, armadaTakeBps: takeBps}));
        emit TierAdded(_tiers.length - 1, threshold, takeBps);
    }

    /// @inheritdoc IArmadaFeeModule
    function setTier(uint256 index, uint256 threshold, uint256 takeBps) external override onlyOwner {
        require(index < _tiers.length, "ArmadaFeeModule: invalid tier index");
        require(takeBps <= MAX_BPS, "ArmadaFeeModule: tier take too high");
        require(threshold > 0, "ArmadaFeeModule: zero threshold");

        _tiers[index] = Tier({volumeThreshold: threshold, armadaTakeBps: takeBps});
        emit TierUpdated(index, threshold, takeBps);
    }

    /// @inheritdoc IArmadaFeeModule
    function removeTier(uint256 index) external override onlyOwner {
        require(index < _tiers.length, "ArmadaFeeModule: invalid tier index");

        // Swap with last and pop
        uint256 lastIndex = _tiers.length - 1;
        if (index != lastIndex) {
            _tiers[index] = _tiers[lastIndex];
        }
        _tiers.pop();

        emit TierRemoved(index);
    }

    /// @inheritdoc IArmadaFeeModule
    function setYieldFee(uint256 bps) external override onlyOwner {
        require(bps >= MIN_YIELD_FEE_BPS, "ArmadaFeeModule: below min yield fee");
        require(bps <= MAX_YIELD_FEE_BPS, "ArmadaFeeModule: above max yield fee");
        emit YieldFeeUpdated(yieldFeeBps, bps);
        yieldFeeBps = bps;
    }

    /// @inheritdoc IArmadaFeeModule
    function setIntegratorTerms(
        address integrator,
        uint256 takeBps,
        uint256 threshold,
        bool active
    ) external override onlyOwner {
        require(integrator != address(0), "ArmadaFeeModule: zero integrator");
        require(takeBps <= MAX_BPS, "ArmadaFeeModule: custom take too high");

        _customTerms[integrator] = CustomTerms({
            customArmadaTakeBps: takeBps,
            customVolumeThreshold: threshold,
            active: active
        });

        emit IntegratorTermsSet(integrator, takeBps, threshold, active);
    }

    /// @inheritdoc IArmadaFeeModule
    function setTreasury(address _treasury) external override onlyOwner {
        require(_treasury != address(0), "ArmadaFeeModule: zero treasury");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @inheritdoc IArmadaFeeModule
    function setPrivacyPool(address _privacyPool) external override onlyOwner {
        require(_privacyPool != address(0), "ArmadaFeeModule: zero privacy pool");
        emit PrivacyPoolUpdated(privacyPool, _privacyPool);
        privacyPool = _privacyPool;
    }

    /// @inheritdoc IArmadaFeeModule
    function setYieldVault(address _yieldVault) external override onlyOwner {
        require(_yieldVault != address(0), "ArmadaFeeModule: zero yield vault");
        emit YieldVaultUpdated(yieldVault, _yieldVault);
        yieldVault = _yieldVault;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // QUERY VIEWS
    // ══════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IArmadaFeeModule
    function getIntegratorInfo(address integrator) external view override returns (IntegratorInfo memory) {
        return _integrators[integrator];
    }

    /// @inheritdoc IArmadaFeeModule
    function getIntegratorTerms(address integrator) external view override returns (CustomTerms memory) {
        return _customTerms[integrator];
    }

    /// @inheritdoc IArmadaFeeModule
    function getTiers() external view override returns (Tier[] memory) {
        return _tiers;
    }

    /// @inheritdoc IArmadaFeeModule
    function getTierCount() external view override returns (uint256) {
        return _tiers.length;
    }

    /// @inheritdoc IArmadaFeeModule
    function getArmadaTake(address integrator) external view override returns (uint256) {
        return _getEffectiveArmadaTake(integrator);
    }

    /// @inheritdoc IArmadaFeeModule
    function getUserFee(address integrator) external view override returns (uint256) {
        uint256 take = _getEffectiveArmadaTake(integrator);
        if (integrator == address(0) || !_integrators[integrator].registered) {
            return take;
        }
        uint256 bonus = _getBonus(integrator);
        return take + _integrators[integrator].baseFee + bonus;
    }

    /// @inheritdoc IArmadaFeeModule
    function getIntegratorBonus(address integrator) external view override returns (uint256) {
        return _getBonus(integrator);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ══════════════════════════════════════════════════════════════════════════

    /// @notice Get the effective Armada take bps for a given integrator, considering
    ///         custom terms and volume tiers.
    function _getEffectiveArmadaTake(address integrator) internal view returns (uint256) {
        // No integrator — base rate
        if (integrator == address(0)) {
            return baseArmadaTakeBps;
        }

        // Custom terms override everything
        if (_customTerms[integrator].active) {
            return _customTerms[integrator].customArmadaTakeBps;
        }

        // Registered integrator — check volume tiers
        if (_integrators[integrator].registered) {
            uint256 volume = _integrators[integrator].cumulativeVolume;
            return _getTieredTake(volume);
        }

        // Unregistered address passed as integrator — base rate
        return baseArmadaTakeBps;
    }

    /// @notice Look up the Armada take bps for a given cumulative volume.
    ///         Tiers are checked from index 0 to N. The matching tier with
    ///         the highest threshold that is <= volume wins. If no tier matches,
    ///         returns baseArmadaTakeBps.
    function _getTieredTake(uint256 volume) internal view returns (uint256) {
        uint256 len = _tiers.length;
        if (len == 0) return baseArmadaTakeBps;

        uint256 bestThreshold = 0;
        uint256 bestTake = baseArmadaTakeBps;

        for (uint256 i = 0; i < len; i++) {
            if (volume >= _tiers[i].volumeThreshold && _tiers[i].volumeThreshold > bestThreshold) {
                bestThreshold = _tiers[i].volumeThreshold;
                bestTake = _tiers[i].armadaTakeBps;
            }
        }

        return bestTake;
    }

    /// @notice Calculate the bonus bps an integrator earns from the volume tier discount.
    ///         bonus = baseArmadaTakeBps - effectiveTakeBps (when volume exceeds a tier threshold).
    function _getBonus(address integrator) internal view returns (uint256) {
        uint256 effectiveTake = _getEffectiveArmadaTake(integrator);
        if (effectiveTake >= baseArmadaTakeBps) {
            return 0;
        }
        return baseArmadaTakeBps - effectiveTake;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // UUPS
    // ══════════════════════════════════════════════════════════════════════════

    /// @dev Only the owner (timelock) can authorize upgrades.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
