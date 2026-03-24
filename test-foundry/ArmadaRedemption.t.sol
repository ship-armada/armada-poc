// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ArmadaRedemption — pro-rata treasury redemption for ARM holders.
// ABOUTME: Covers single/sequential redemption, ETH redemption, denominator math, and edge cases.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaRedemption.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockTokenRedemption is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract ArmadaRedemptionTest is Test {
    // Mirror events
    event Redeemed(address indexed redeemer, uint256 armAmount, address[] tokens);
    event RedeemedETH(address indexed redeemer, uint256 armAmount, uint256 ethAmount);

    ArmadaRedemption public redemption;
    ArmadaToken public armToken;
    TimelockController public timelock;
    MockTokenRedemption public usdc;
    MockTokenRedemption public weth;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public treasuryAddr = address(0x7777);
    address public revenueLock = address(0xABCD);
    address public crowdfund = address(0xCF00);
    address public windDown = address(0xD00D);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;

    function setUp() public {
        // Deploy governance token
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));

        // Enable transfers (simulating wind-down having triggered)
        armToken.setWindDownContract(windDown);
        vm.prank(windDown);
        armToken.setTransferable(true);

        // Whitelist deployer, alice, bob, and the redemption contract address
        // (We need to deploy redemption first to know its address, or whitelist after)
        // Since transfers are enabled, whitelist doesn't matter anymore

        // Deploy redemption
        redemption = new ArmadaRedemption(
            address(armToken),
            treasuryAddr,
            revenueLock,
            crowdfund
        );

        // Distribute ARM
        // Treasury gets 65%, revenue-lock gets 15%, crowdfund gets 10%, alice 5%, bob 5%
        armToken.transfer(treasuryAddr, TOTAL_SUPPLY * 65 / 100);  // 7.8M
        armToken.transfer(revenueLock, TOTAL_SUPPLY * 15 / 100);   // 1.8M
        armToken.transfer(crowdfund, TOTAL_SUPPLY * 10 / 100);      // 1.2M
        armToken.transfer(alice, TOTAL_SUPPLY * 5 / 100);           // 600K
        armToken.transfer(bob, TOTAL_SUPPLY * 5 / 100);             // 600K

        // Deploy mock tokens and fund redemption (simulating post-sweep)
        usdc = new MockTokenRedemption("Mock USDC", "USDC");
        weth = new MockTokenRedemption("Wrapped ETH", "WETH");

        usdc.mint(address(redemption), 500_000e6);  // $500k USDC in redemption
        weth.mint(address(redemption), 100e18);       // 100 WETH in redemption

        // Approve redemption to take ARM from alice and bob
        vm.prank(alice);
        armToken.approve(address(redemption), type(uint256).max);
        vm.prank(bob);
        armToken.approve(address(redemption), type(uint256).max);
    }

    // ======== Basic Redemption ========

    function test_redeem_proRataUSDC() public {
        // Circulating supply = total - treasury - revenueLock - crowdfund - redemption(0)
        // = 12M - 7.8M - 1.8M - 1.2M - 0 = 1.2M ARM circulating
        uint256 circulating = redemption.circulatingSupply();
        assertEq(circulating, TOTAL_SUPPLY * 10 / 100); // 1.2M = 10%

        uint256 aliceArm = armToken.balanceOf(alice); // 600K
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        // Alice has 600K out of 1.2M circulating = 50% → $250k USDC
        assertEq(usdc.balanceOf(alice), 250_000e6);
    }

    function test_redeem_multipleTokens() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(weth);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        // 50% of each
        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(weth.balanceOf(alice), 50e18);
    }

    function test_redeem_armLockedPermanently() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        // ARM is in the redemption contract
        assertEq(armToken.balanceOf(address(redemption)), aliceArm);
        // Alice has no ARM
        assertEq(armToken.balanceOf(alice), 0);
    }

    // ======== Sequential Correctness ========

    function test_sequential_correctness() public {
        uint256 aliceArm = armToken.balanceOf(alice); // 600K
        uint256 bobArm = armToken.balanceOf(bob);     // 600K

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Alice redeems first (600K out of 1.2M = 50%)
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);
        assertEq(usdc.balanceOf(alice), 250_000e6); // 50% of $500k

        // After Alice's redemption:
        // - Redemption contract has 600K ARM
        // - Circulating = 12M - 7.8M - 1.8M - 1.2M - 600K = 600K
        // - USDC remaining = 250k
        // Bob redeems (600K out of 600K = 100%)
        vm.prank(bob);
        redemption.redeem(bobArm, tokens);
        assertEq(usdc.balanceOf(bob), 250_000e6); // 100% of remaining $250k

        // Both got equal shares: $250k each
    }

    function test_partial_redemption() public {
        uint256 halfArm = armToken.balanceOf(alice) / 2; // 300K

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Alice redeems half her ARM (300K out of 1.2M = 25%)
        vm.prank(alice);
        redemption.redeem(halfArm, tokens);
        assertEq(usdc.balanceOf(alice), 125_000e6); // 25% of $500k

        // Alice redeems other half (300K out of 900K remaining circulating)
        // 300K / 900K = 33.3% of remaining $375k = $125k
        vm.prank(alice);
        redemption.redeem(halfArm, tokens);
        assertEq(usdc.balanceOf(alice), 250_000e6); // Total still $250k
    }

    // ======== ETH Redemption ========

    function test_redeemETH() public {
        // Fund redemption with ETH
        vm.deal(address(redemption), 10 ether);

        uint256 aliceArm = armToken.balanceOf(alice); // 600K out of 1.2M = 50%

        vm.prank(alice);
        redemption.redeemETH(aliceArm);

        assertEq(alice.balance, 5 ether); // 50% of 10 ETH
    }

    // ======== Circulating Supply ========

    function test_circulatingSupply_excludesCorrectAddresses() public {
        uint256 circulating = redemption.circulatingSupply();
        uint256 total = armToken.totalSupply();
        uint256 excluded = armToken.balanceOf(treasuryAddr) +
                          armToken.balanceOf(revenueLock) +
                          armToken.balanceOf(crowdfund) +
                          armToken.balanceOf(address(redemption));

        assertEq(circulating, total - excluded);
    }

    function test_circulatingSupply_shrinksAfterRedemption() public {
        uint256 circulatingBefore = redemption.circulatingSupply();

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        uint256 circulatingAfter = redemption.circulatingSupply();
        assertTrue(circulatingAfter < circulatingBefore);
        assertEq(circulatingAfter, circulatingBefore - aliceArm);
    }

    // ======== Edge Cases ========

    function test_revert_zeroArmAmount() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero amount");
        redemption.redeem(0, tokens);
    }

    function test_revert_zeroArmAmount_eth() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero amount");
        redemption.redeemETH(0);
    }

    function test_redeem_emptyTokenList() public {
        address[] memory tokens = new address[](0);
        uint256 aliceArm = armToken.balanceOf(alice);

        // Should succeed — ARM is transferred, but no tokens distributed
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        // ARM is locked
        assertEq(armToken.balanceOf(alice), 0);
        assertEq(armToken.balanceOf(address(redemption)), aliceArm);
    }

    function test_redeem_tokenWithZeroBalance() public {
        MockTokenRedemption emptyToken = new MockTokenRedemption("Empty", "EMPTY");
        address[] memory tokens = new address[](1);
        tokens[0] = address(emptyToken);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens);

        assertEq(emptyToken.balanceOf(alice), 0);
    }

    function test_redemptionCanReceiveETH() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(redemption).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(redemption).balance, 1 ether);
    }

    // ======== Constructor Validation ========

    function test_constructorRejectsZeroArmToken() public {
        vm.expectRevert("ArmadaRedemption: zero armToken");
        new ArmadaRedemption(address(0), treasuryAddr, revenueLock, crowdfund);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert("ArmadaRedemption: zero treasury");
        new ArmadaRedemption(address(armToken), address(0), revenueLock, crowdfund);
    }

    function test_constructorRejectsZeroRevenueLock() public {
        vm.expectRevert("ArmadaRedemption: zero revenueLock");
        new ArmadaRedemption(address(armToken), treasuryAddr, address(0), crowdfund);
    }

    function test_constructorRejectsZeroCrowdfund() public {
        vm.expectRevert("ArmadaRedemption: zero crowdfund");
        new ArmadaRedemption(address(armToken), treasuryAddr, revenueLock, address(0));
    }
}
