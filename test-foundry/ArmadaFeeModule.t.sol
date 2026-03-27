// ABOUTME: Foundry unit tests for ArmadaFeeModule covering fee calculation, tier matching,
// ABOUTME: integrator registration, governance setters, access control, and IFeeCollector.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/fees/ArmadaFeeModule.sol";
import "../contracts/fees/IArmadaFeeModule.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ArmadaFeeModuleTest is Test {
    ArmadaFeeModule public feeModule;

    address public owner = address(this);
    address public treasury = address(0xFEE);
    address public privacyPool = address(0xBEEF);
    address public yieldVault = address(0xCAFE);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public integrator1 = address(0x1111);
    address public integrator2 = address(0x2222);
    address public nonOwner = address(0xBAD);

    // Events (for expectEmit)
    event IntegratorRegistered(address indexed integrator, uint256 baseFee);
    event ShieldFeeRecorded(address indexed integrator, uint256 amount, uint256 armadaTake, uint256 integratorFee);
    event YieldFeeRecorded(uint256 amount);
    event BaseArmadaTakeUpdated(uint256 oldBps, uint256 newBps);
    event TierAdded(uint256 index, uint256 volumeThreshold, uint256 armadaTakeBps);
    event TierUpdated(uint256 index, uint256 volumeThreshold, uint256 armadaTakeBps);
    event TierRemoved(uint256 index);
    event YieldFeeUpdated(uint256 oldBps, uint256 newBps);
    event IntegratorTermsSet(address indexed integrator, uint256 takeBps, uint256 threshold, bool active);

    function setUp() public {
        // Deploy implementation + proxy
        ArmadaFeeModule impl = new ArmadaFeeModule();
        bytes memory initData = abi.encodeCall(
            ArmadaFeeModule.initialize,
            (owner, treasury, privacyPool, yieldVault)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        feeModule = ArmadaFeeModule(address(proxy));
    }

    // ══════════════════════════════════════════════════════════════════════
    // Initialization
    // ══════════════════════════════════════════════════════════════════════

    function test_initialize_setsDefaults() public view {
        assertEq(feeModule.baseArmadaTakeBps(), 50);
        assertEq(feeModule.yieldFeeBps(), 1500);
        assertEq(feeModule.treasury(), treasury);
        assertEq(feeModule.privacyPool(), privacyPool);
        assertEq(feeModule.yieldVault(), yieldVault);
        assertEq(feeModule.getTierCount(), 1);

        IArmadaFeeModule.Tier[] memory tiers = feeModule.getTiers();
        assertEq(tiers[0].volumeThreshold, 250_000e6);
        assertEq(tiers[0].armadaTakeBps, 40);
    }

    function test_initialize_cannotReinitialize() public {
        vm.expectRevert("Initializable: contract is already initialized");
        feeModule.initialize(owner, treasury, privacyPool, yieldVault);
    }

    function test_initialize_revertsOnZeroAddress() public {
        ArmadaFeeModule impl = new ArmadaFeeModule();
        bytes memory badInit = abi.encodeCall(
            ArmadaFeeModule.initialize,
            (address(0), treasury, privacyPool, yieldVault)
        );
        vm.expectRevert("ArmadaFeeModule: zero owner");
        new ERC1967Proxy(address(impl), badInit);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fee Calculation — No Integrator
    // ══════════════════════════════════════════════════════════════════════

    function test_calculateShieldFee_noIntegrator() public view {
        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(address(0), 10_000e6);

        // 50 bps of 10,000 USDC = 50 USDC
        assertEq(armadaTake, 50e6);
        assertEq(integratorFee, 0);
        assertEq(totalFee, 50e6);
    }

    function test_calculateShieldFee_zeroAmount() public view {
        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(address(0), 0);

        assertEq(armadaTake, 0);
        assertEq(integratorFee, 0);
        assertEq(totalFee, 0);
    }

    function test_calculateShieldFee_unregisteredIntegrator() public view {
        // Unregistered address passed as integrator uses base rate, no integrator fee
        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(integrator1, 10_000e6);

        assertEq(armadaTake, 50e6);
        assertEq(integratorFee, 0);
        assertEq(totalFee, 50e6);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fee Calculation — With Integrator
    // ══════════════════════════════════════════════════════════════════════

    function test_calculateShieldFee_withIntegrator_belowTier() public {
        // Register integrator with 30 bps base fee
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(integrator1, 10_000e6);

        // Armada take: 50 bps = 50 USDC (below tier threshold, no discount)
        // Integrator fee: 30 bps + 0 bonus = 30 USDC
        // Total: 80 USDC
        assertEq(armadaTake, 50e6);
        assertEq(integratorFee, 30e6);
        assertEq(totalFee, 80e6);
    }

    function test_calculateShieldFee_withIntegrator_aboveTier() public {
        // Register integrator with 30 bps base fee
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        // Push integrator volume above $250k tier
        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 300_000e6, 150e6, 90e6);

        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(integrator1, 10_000e6);

        // Armada take: 40 bps (tier 1) = 40 USDC
        // Bonus: 50 - 40 = 10 bps
        // Integrator fee: (30 + 10) bps = 40 bps = 40 USDC
        // Total: 80 USDC
        assertEq(armadaTake, 40e6);
        assertEq(integratorFee, 40e6);
        assertEq(totalFee, 80e6);
    }

    function test_calculateShieldFee_withCustomTerms() public {
        // Register integrator
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        // Set custom terms: 20 bps armada take, 100k threshold
        feeModule.setIntegratorTerms(integrator1, 20, 100_000e6, true);

        (uint256 armadaTake, uint256 integratorFee, uint256 totalFee) =
            feeModule.calculateShieldFee(integrator1, 10_000e6);

        // Custom terms: 20 bps armada take = 20 USDC
        // Bonus: 50 - 20 = 30 bps (custom takes override tiers)
        // Integrator fee: (30 + 30) bps = 60 USDC
        // Total: 80 USDC
        assertEq(armadaTake, 20e6);
        assertEq(integratorFee, 60e6);
        assertEq(totalFee, 80e6);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Tier Matching
    // ══════════════════════════════════════════════════════════════════════

    function test_tierMatching_multipleTiers() public {
        // Add second tier: $1M → 30 bps
        feeModule.addTier(1_000_000e6, 30);

        vm.prank(integrator1);
        feeModule.setIntegratorFee(20);

        // Below both tiers
        (uint256 take1, , ) = feeModule.calculateShieldFee(integrator1, 1000e6);
        assertEq(take1, (1000e6 * 50) / 10000); // base rate

        // Push volume above $250k
        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 300_000e6, 0, 0);

        (uint256 take2, , ) = feeModule.calculateShieldFee(integrator1, 1000e6);
        assertEq(take2, (1000e6 * 40) / 10000); // tier 1: 40 bps

        // Push volume above $1M
        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 800_000e6, 0, 0);

        (uint256 take3, , ) = feeModule.calculateShieldFee(integrator1, 1000e6);
        assertEq(take3, (1000e6 * 30) / 10000); // tier 2: 30 bps
    }

    function test_tierMatching_edgeCaseAtBoundary() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(10);

        // Volume exactly at threshold
        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 250_000e6, 0, 0);

        uint256 take = feeModule.getArmadaTake(integrator1);
        assertEq(take, 40); // Should match tier 1
    }

    // ══════════════════════════════════════════════════════════════════════
    // Integrator Registration
    // ══════════════════════════════════════════════════════════════════════

    function test_setIntegratorFee_permissionless() public {
        vm.prank(integrator1);
        vm.expectEmit(true, false, false, true);
        emit IntegratorRegistered(integrator1, 50);
        feeModule.setIntegratorFee(50);

        IArmadaFeeModule.IntegratorInfo memory info = feeModule.getIntegratorInfo(integrator1);
        assertTrue(info.registered);
        assertEq(info.baseFee, 50);
    }

    function test_setIntegratorFee_revertsAboveMax() public {
        vm.prank(integrator1);
        vm.expectRevert("ArmadaFeeModule: integrator fee too high");
        feeModule.setIntegratorFee(501); // MAX_INTEGRATOR_FEE_BPS = 500
    }

    function test_setIntegratorFee_canUpdateFee() public {
        vm.startPrank(integrator1);
        feeModule.setIntegratorFee(30);
        feeModule.setIntegratorFee(50);
        vm.stopPrank();

        assertEq(feeModule.getIntegratorInfo(integrator1).baseFee, 50);
    }

    function test_volumeAccumulation() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        vm.startPrank(privacyPool);
        feeModule.recordShieldFee(integrator1, 100_000e6, 50e6, 30e6);
        feeModule.recordShieldFee(integrator1, 200_000e6, 100e6, 60e6);
        vm.stopPrank();

        IArmadaFeeModule.IntegratorInfo memory info = feeModule.getIntegratorInfo(integrator1);
        assertEq(info.cumulativeVolume, 300_000e6);
        assertEq(info.cumulativeEarnings, 90e6);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Governance Setters
    // ══════════════════════════════════════════════════════════════════════

    function test_setBaseArmadaTake_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setBaseArmadaTake(60);
    }

    function test_setBaseArmadaTake_updates() public {
        vm.expectEmit(false, false, false, true);
        emit BaseArmadaTakeUpdated(50, 60);
        feeModule.setBaseArmadaTake(60);
        assertEq(feeModule.baseArmadaTakeBps(), 60);
    }

    function test_setBaseArmadaTake_revertsAboveMax() public {
        vm.expectRevert("ArmadaFeeModule: take too high");
        feeModule.setBaseArmadaTake(1001); // MAX_BPS = 1000
    }

    function test_addTier() public {
        vm.expectEmit(false, false, false, true);
        emit TierAdded(1, 500_000e6, 35);
        feeModule.addTier(500_000e6, 35);
        assertEq(feeModule.getTierCount(), 2);
    }

    function test_addTier_revertsAtMaxTiers() public {
        // Already have 1 tier, add 9 more to reach limit
        for (uint256 i = 0; i < 9; i++) {
            feeModule.addTier((i + 2) * 100_000e6, 40);
        }
        assertEq(feeModule.getTierCount(), 10);

        vm.expectRevert("ArmadaFeeModule: max tiers reached");
        feeModule.addTier(2_000_000e6, 30);
    }

    function test_setTier_updates() public {
        feeModule.setTier(0, 300_000e6, 35);
        IArmadaFeeModule.Tier[] memory tiers = feeModule.getTiers();
        assertEq(tiers[0].volumeThreshold, 300_000e6);
        assertEq(tiers[0].armadaTakeBps, 35);
    }

    function test_removeTier() public {
        feeModule.addTier(500_000e6, 35);
        assertEq(feeModule.getTierCount(), 2);

        feeModule.removeTier(0);
        assertEq(feeModule.getTierCount(), 1);
        // The last tier was swapped into position 0
        IArmadaFeeModule.Tier[] memory tiers = feeModule.getTiers();
        assertEq(tiers[0].volumeThreshold, 500_000e6);
    }

    function test_setYieldFee_bounds() public {
        // Below min
        vm.expectRevert("ArmadaFeeModule: below min yield fee");
        feeModule.setYieldFee(99);

        // Above max
        vm.expectRevert("ArmadaFeeModule: above max yield fee");
        feeModule.setYieldFee(5001);

        // Valid
        feeModule.setYieldFee(2000);
        assertEq(feeModule.yieldFeeBps(), 2000);
    }

    function test_setIntegratorTerms() public {
        vm.expectEmit(true, false, false, true);
        emit IntegratorTermsSet(integrator1, 25, 100_000e6, true);
        feeModule.setIntegratorTerms(integrator1, 25, 100_000e6, true);

        IArmadaFeeModule.CustomTerms memory terms = feeModule.getIntegratorTerms(integrator1);
        assertTrue(terms.active);
        assertEq(terms.customArmadaTakeBps, 25);
        assertEq(terms.customVolumeThreshold, 100_000e6);
    }

    function test_setIntegratorTerms_revertsOnZeroAddress() public {
        vm.expectRevert("ArmadaFeeModule: zero integrator");
        feeModule.setIntegratorTerms(address(0), 25, 100_000e6, true);
    }

    // ══════════════════════════════════════════════════════════════════════
    // IFeeCollector — Monotonic Cumulative Counter
    // ══════════════════════════════════════════════════════════════════════

    function test_cumulativeFeesCollected_monotonic() public {
        assertEq(feeModule.cumulativeFeesCollected(), 0);

        vm.prank(privacyPool);
        feeModule.recordShieldFee(address(0), 10_000e6, 5e6, 0);
        assertEq(feeModule.cumulativeFeesCollected(), 5e6);

        vm.prank(yieldVault);
        feeModule.recordYieldFee(10e6);
        assertEq(feeModule.cumulativeFeesCollected(), 15e6);
    }

    function test_cumulativeFeesCollected_excludesIntegratorFees() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 10_000e6, 5e6, 3e6);

        // Only armada take (5e6) is protocol revenue
        assertEq(feeModule.cumulativeFeesCollected(), 5e6);
        // Integrator fees tracked separately
        assertEq(feeModule.cumulativeIntegratorFees(), 3e6);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Access Control
    // ══════════════════════════════════════════════════════════════════════

    function test_recordShieldFee_onlyPrivacyPool() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaFeeModule: only privacy pool");
        feeModule.recordShieldFee(address(0), 10_000e6, 5e6, 0);
    }

    function test_recordYieldFee_onlyYieldVault() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaFeeModule: only yield vault");
        feeModule.recordYieldFee(10e6);
    }

    function test_governanceSetters_onlyOwner() public {
        vm.startPrank(nonOwner);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setBaseArmadaTake(60);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.addTier(500_000e6, 35);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setTier(0, 300_000e6, 35);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.removeTier(0);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setYieldFee(2000);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setIntegratorTerms(integrator1, 25, 100_000e6, true);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setTreasury(alice);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setPrivacyPool(alice);

        vm.expectRevert("Ownable: caller is not the owner");
        feeModule.setYieldVault(alice);

        vm.stopPrank();
    }

    // ══════════════════════════════════════════════════════════════════════
    // Query Views
    // ══════════════════════════════════════════════════════════════════════

    function test_getUserFee_noIntegrator() public view {
        uint256 fee = feeModule.getUserFee(address(0));
        assertEq(fee, 50); // base armada take only
    }

    function test_getUserFee_withIntegrator() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        uint256 fee = feeModule.getUserFee(integrator1);
        assertEq(fee, 80); // 50 (armada) + 30 (integrator base) + 0 (no bonus yet)
    }

    function test_getIntegratorBonus_belowTier() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        assertEq(feeModule.getIntegratorBonus(integrator1), 0);
    }

    function test_getIntegratorBonus_aboveTier() public {
        vm.prank(integrator1);
        feeModule.setIntegratorFee(30);

        // Push above tier
        vm.prank(privacyPool);
        feeModule.recordShieldFee(integrator1, 300_000e6, 0, 0);

        // Bonus = 50 (base) - 40 (tier 1) = 10
        assertEq(feeModule.getIntegratorBonus(integrator1), 10);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz Tests
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_calculateShieldFee_totalNeverExceedsAmount(uint256 amount) public view {
        amount = bound(amount, 0, 1_000_000_000e6); // up to $1B

        (, , uint256 totalFee) = feeModule.calculateShieldFee(address(0), amount);
        assertLe(totalFee, amount);
    }

    function testFuzz_calculateShieldFee_withIntegrator_totalNeverExceedsAmount(
        uint256 amount,
        uint256 integratorFee
    ) public {
        amount = bound(amount, 0, 1_000_000_000e6);
        integratorFee = bound(integratorFee, 0, 500);

        vm.prank(integrator1);
        feeModule.setIntegratorFee(integratorFee);

        (, , uint256 totalFee) = feeModule.calculateShieldFee(integrator1, amount);
        assertLe(totalFee, amount);
    }

    function testFuzz_setBaseArmadaTake_withinBounds(uint256 bps) public {
        bps = bound(bps, 0, 1000);
        feeModule.setBaseArmadaTake(bps);
        assertEq(feeModule.baseArmadaTakeBps(), bps);
    }

    function testFuzz_setYieldFee_withinBounds(uint256 bps) public {
        bps = bound(bps, 100, 5000);
        feeModule.setYieldFee(bps);
        assertEq(feeModule.yieldFeeBps(), bps);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Address Setter Views
    // ══════════════════════════════════════════════════════════════════════

    function test_setTreasury_updates() public {
        address newTreasury = address(0xDEAD);
        feeModule.setTreasury(newTreasury);
        assertEq(feeModule.treasury(), newTreasury);
    }

    function test_setPrivacyPool_updates() public {
        address newPool = address(0xDEAD);
        feeModule.setPrivacyPool(newPool);
        assertEq(feeModule.privacyPool(), newPool);
    }

    function test_setYieldVault_updates() public {
        address newVault = address(0xDEAD);
        feeModule.setYieldVault(newVault);
        assertEq(feeModule.yieldVault(), newVault);
    }

    function test_setTreasury_revertsZero() public {
        vm.expectRevert("ArmadaFeeModule: zero treasury");
        feeModule.setTreasury(address(0));
    }

    function test_setPrivacyPool_revertsZero() public {
        vm.expectRevert("ArmadaFeeModule: zero privacy pool");
        feeModule.setPrivacyPool(address(0));
    }

    function test_setYieldVault_revertsZero() public {
        vm.expectRevert("ArmadaFeeModule: zero yield vault");
        feeModule.setYieldVault(address(0));
    }
}
