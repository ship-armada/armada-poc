// ABOUTME: Foundry tests for the governable yield fee in ArmadaYieldVault.
// ABOUTME: Covers setYieldFeeBps access control, bounds enforcement, event emission, and fee application.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title YieldFeeGovernanceTest — Tests for setYieldFeeBps and governable yield fee
contract YieldFeeGovernanceTest is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    MockAaveSpoke public spoke;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public nonOwner = address(0xBAD);

    uint256 constant YIELD_BPS = 500; // 5% APY for mock spoke
    uint256 constant DEPOSIT_AMOUNT = 100_000 * 1e6; // 100k USDC

    event YieldFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), YIELD_BPS, true);

        // Treasury is the unified ArmadaTreasuryGov (#152/#154). Tests here only use
        // it as a fee-sink address; the timelock-owner arg is satisfied by address(this).
        treasury = new ArmadaTreasuryGov(address(this));
        vault = new ArmadaYieldVault(
            address(spoke),
            0,
            address(treasury),
            "Armada Yield USDC",
            "ayUSDC"
        );

        // Fund alice
        usdc.mint(alice, DEPOSIT_AMOUNT * 2);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Access control
    // ══════════════════════════════════════════════════════════════════════

    function test_setYieldFeeBps_onlyOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert("ArmadaYieldVault: not owner");
        vault.setYieldFeeBps(2000);
    }

    function test_setYieldFeeBps_ownerSucceeds() public {
        vault.setYieldFeeBps(2000);
        assertEq(vault.yieldFeeBps(), 2000);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Bounds enforcement
    // ══════════════════════════════════════════════════════════════════════

    function test_setYieldFeeBps_rejectsBelowMin() public {
        vm.expectRevert("ArmadaYieldVault: below min fee");
        vault.setYieldFeeBps(99); // below MIN_YIELD_FEE_BPS (100)
    }

    function test_setYieldFeeBps_rejectsAboveMax() public {
        vm.expectRevert("ArmadaYieldVault: above max fee");
        vault.setYieldFeeBps(5001); // above MAX_YIELD_FEE_BPS (5000)
    }

    function test_setYieldFeeBps_acceptsMin() public {
        vault.setYieldFeeBps(100);
        assertEq(vault.yieldFeeBps(), 100);
    }

    function test_setYieldFeeBps_acceptsMax() public {
        vault.setYieldFeeBps(5000);
        assertEq(vault.yieldFeeBps(), 5000);
    }

    function test_setYieldFeeBps_rejectsZero() public {
        vm.expectRevert("ArmadaYieldVault: below min fee");
        vault.setYieldFeeBps(0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Event emission
    // ══════════════════════════════════════════════════════════════════════

    function test_setYieldFeeBps_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit YieldFeeUpdated(1000, 2000);
        vault.setYieldFeeBps(2000);
    }

    function test_setYieldFeeBps_emitsCorrectOldValue() public {
        vault.setYieldFeeBps(3000);

        vm.expectEmit(false, false, false, true);
        emit YieldFeeUpdated(3000, 500);
        vault.setYieldFeeBps(500);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fee application in redeem and previewRedeem
    // ══════════════════════════════════════════════════════════════════════

    /// @dev WHY: a fee-rate change applies only to yield earned after it (#617). Raising the rate
    ///      must not re-price yield already earned; the new rate applies from then on, and redeem
    ///      pays exactly what previewRedeem quoted.
    function test_changedFee_appliesOnlyToYieldAfterTheChange() public {
        // Deposit
        vm.startPrank(alice);
        usdc.approve(address(vault), DEPOSIT_AMOUNT);
        uint256 shares = vault.deposit(DEPOSIT_AMOUNT, alice);
        vm.stopPrank();

        // Year 1 at the default 10% fee
        vm.warp(block.timestamp + 365 days);
        uint256 previewBeforeChange = vault.previewRedeem(shares, alice);
        uint256 assetsAfterYear1 = vault.totalAssets();

        // Raising the fee to 50% does not re-price year 1
        vault.setYieldFeeBps(5000);
        assertEq(vault.previewRedeem(shares, alice), previewBeforeChange, "rate change re-priced past yield");

        // Year 2 is charged at 50%
        vm.warp(block.timestamp + 365 days);
        uint256 assetsAfterYear2 = vault.totalAssets();
        uint256 expectedFee = ((assetsAfterYear1 - DEPOSIT_AMOUNT) * 1000) / 10000
            + ((assetsAfterYear2 - assetsAfterYear1) * 5000) / 10000;
        assertApproxEqAbs(vault.pendingProtocolFee(), expectedFee, 2, "fee across the rate change");

        // Redeem pays what preview quoted
        uint256 preview = vault.previewRedeem(shares, alice);
        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertEq(assets, preview, "redeem should match preview");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Default value
    // ══════════════════════════════════════════════════════════════════════

    function test_defaultYieldFee() public view {
        assertEq(vault.yieldFeeBps(), 1000, "default fee should be 10%");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz: bounds
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_setYieldFeeBps_withinBounds(uint256 feeBps) public {
        feeBps = bound(feeBps, 100, 5000);
        vault.setYieldFeeBps(feeBps);
        assertEq(vault.yieldFeeBps(), feeBps);
    }

    function testFuzz_setYieldFeeBps_belowMinReverts(uint256 feeBps) public {
        feeBps = bound(feeBps, 0, 99);
        vm.expectRevert("ArmadaYieldVault: below min fee");
        vault.setYieldFeeBps(feeBps);
    }

    function testFuzz_setYieldFeeBps_aboveMaxReverts(uint256 feeBps) public {
        feeBps = bound(feeBps, 5001, type(uint256).max);
        vm.expectRevert("ArmadaYieldVault: above max fee");
        vault.setYieldFeeBps(feeBps);
    }
}
