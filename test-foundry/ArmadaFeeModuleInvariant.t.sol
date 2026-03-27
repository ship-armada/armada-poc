// ABOUTME: Foundry invariant tests for ArmadaFeeModule verifying monotonic counters,
// ABOUTME: fee bounds, and tier array size constraints under random state transitions.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/fees/ArmadaFeeModule.sol";
import "../contracts/fees/IArmadaFeeModule.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title ArmadaFeeModuleHandler — Target for invariant testing
/// @notice Exposes bounded actions that the fuzzer can call to exercise ArmadaFeeModule state transitions.
contract ArmadaFeeModuleHandler is Test {
    ArmadaFeeModule public feeModule;
    address public owner;
    address public privacyPool;
    address public yieldVault;
    address public integrator;

    uint256 public ghost_totalArmadaFees;
    uint256 public ghost_totalIntegratorVolume;

    constructor(ArmadaFeeModule _feeModule, address _owner, address _privacyPool, address _yieldVault, address _integrator) {
        feeModule = _feeModule;
        owner = _owner;
        privacyPool = _privacyPool;
        yieldVault = _yieldVault;
        integrator = _integrator;
    }

    function recordShieldFee(uint256 amount, uint256 armadaTake) public {
        amount = bound(amount, 1e6, 10_000_000e6);
        armadaTake = bound(armadaTake, 0, amount);
        uint256 integratorFee = bound(amount / 100, 0, amount - armadaTake);

        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator, amount, armadaTake, integratorFee);

        ghost_totalArmadaFees += armadaTake;
        ghost_totalIntegratorVolume += amount;
    }

    function recordYieldFee(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);

        vm.prank(yieldVault);
        feeModule.recordYieldFee(amount);

        ghost_totalArmadaFees += amount;
    }

    function addTier(uint256 threshold, uint256 takeBps) public {
        threshold = bound(threshold, 1, 100_000_000e6);
        takeBps = bound(takeBps, 0, 1000);

        if (feeModule.getTierCount() >= 10) return; // silently skip at max

        vm.prank(owner);
        feeModule.addTier(threshold, takeBps);
    }

    function removeTier(uint256 index) public {
        uint256 count = feeModule.getTierCount();
        if (count == 0) return;
        index = bound(index, 0, count - 1);

        vm.prank(owner);
        feeModule.removeTier(index);
    }

    function calculateFee(uint256 amount) public view returns (uint256 totalFee) {
        amount = bound(amount, 0, 10_000_000_000e6);
        (, , totalFee) = feeModule.calculateShieldFee(address(0), amount);
    }
}

/// @title ArmadaFeeModuleInvariantTest — Invariant property tests
contract ArmadaFeeModuleInvariantTest is Test {
    ArmadaFeeModule public feeModule;
    ArmadaFeeModuleHandler public handler;

    address public owner = address(this);
    address public treasury = address(0xFEE);
    address public privacyPool = address(0xBEEF);
    address public yieldVault = address(0xCAFE);
    address public integrator = address(0x1111);

    function setUp() public {
        // Deploy proxy
        ArmadaFeeModule impl = new ArmadaFeeModule();
        bytes memory initData = abi.encodeCall(
            ArmadaFeeModule.initialize,
            (owner, treasury, privacyPool, yieldVault)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        feeModule = ArmadaFeeModule(address(proxy));

        // Register integrator
        vm.prank(integrator);
        feeModule.setIntegratorFee(30);

        // Create handler
        handler = new ArmadaFeeModuleHandler(feeModule, owner, privacyPool, yieldVault, integrator);

        // Target only the handler
        targetContract(address(handler));
    }

    /// @notice cumulativeArmadaFees is monotonically non-decreasing
    function invariant_cumulativeArmadaFees_monotonic() public view {
        assertGe(feeModule.cumulativeArmadaFees(), 0);
        assertEq(feeModule.cumulativeArmadaFees(), handler.ghost_totalArmadaFees());
    }

    /// @notice cumulativeFeesCollected matches cumulativeArmadaFees
    function invariant_feeCollector_consistency() public view {
        assertEq(feeModule.cumulativeFeesCollected(), feeModule.cumulativeArmadaFees());
    }

    /// @notice integrator cumulative volume is monotonically non-decreasing
    function invariant_integratorVolume_monotonic() public view {
        IArmadaFeeModule.IntegratorInfo memory info = feeModule.getIntegratorInfo(integrator);
        assertEq(info.cumulativeVolume, handler.ghost_totalIntegratorVolume());
    }

    /// @notice Tiers array never exceeds MAX_TIERS (10)
    function invariant_tiers_length_bounded() public view {
        assertLe(feeModule.getTierCount(), 10);
    }

    /// @notice totalFee from calculateShieldFee never exceeds input amount
    function invariant_fee_never_exceeds_amount() public view {
        uint256 amount = 1_000_000e6;
        (, , uint256 totalFee) = feeModule.calculateShieldFee(address(0), amount);
        assertLe(totalFee, amount);

        (, , uint256 totalFee2) = feeModule.calculateShieldFee(integrator, amount);
        assertLe(totalFee2, amount);
    }
}
