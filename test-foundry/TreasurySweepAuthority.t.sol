// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for treasury wind-down sweep authority (transferTo, transferETHTo).
// ABOUTME: Verifies wind-down-only access, outflow limit bypass, and ETH handling.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal mock ERC20 for testing
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract TreasurySweepAuthorityTest is Test {
    // Mirror events
    event WindDownContractSet(address indexed windDownContract);
    event WindDownTransfer(address indexed token, address indexed recipient, uint256 amount);
    event WindDownETHTransfer(address indexed recipient, uint256 amount);

    ArmadaTreasuryGov public treasury;
    MockToken public usdc;

    address public timelockAddr = address(0x7171); // mock timelock (owner)
    address public windDown = address(0xD00D);
    address public recipient = address(0xBEEF);
    address public randomUser = address(0xCAFE);

    function setUp() public {
        treasury = new ArmadaTreasuryGov(timelockAddr);
        usdc = new MockToken("Mock USDC", "USDC");

        // Fund treasury with USDC
        usdc.mint(address(treasury), 1_000_000e6);
    }

    // ======== setWindDownContract ========

    function test_setWindDownContract_success() public {
        vm.prank(timelockAddr);
        vm.expectEmit(true, false, false, false);
        emit WindDownContractSet(windDown);
        treasury.setWindDownContract(windDown);

        assertEq(treasury.windDownContract(), windDown);
        assertTrue(treasury.windDownContractSet());
    }

    function test_setWindDownContract_onlyOwner() public {
        vm.prank(randomUser);
        vm.expectRevert("ArmadaTreasuryGov: not owner");
        treasury.setWindDownContract(windDown);
    }

    function test_setWindDownContract_onlyOnce() public {
        vm.prank(timelockAddr);
        treasury.setWindDownContract(windDown);

        vm.prank(timelockAddr);
        vm.expectRevert("ArmadaTreasuryGov: wind-down already set");
        treasury.setWindDownContract(address(0x999));
    }

    function test_setWindDownContract_rejectsZero() public {
        vm.prank(timelockAddr);
        vm.expectRevert("ArmadaTreasuryGov: zero address");
        treasury.setWindDownContract(address(0));
    }

    // ======== transferTo ========

    function test_transferTo_windDownOnly() public {
        _setupWindDown();

        uint256 amount = 500_000e6;
        vm.prank(windDown);
        vm.expectEmit(true, true, false, true);
        emit WindDownTransfer(address(usdc), recipient, amount);
        treasury.transferTo(address(usdc), recipient, amount);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(treasury)), 500_000e6);
    }

    function test_transferTo_revertsForOwner() public {
        _setupWindDown();

        vm.prank(timelockAddr);
        vm.expectRevert("ArmadaTreasuryGov: not wind-down");
        treasury.transferTo(address(usdc), recipient, 100e6);
    }

    function test_transferTo_revertsForRandom() public {
        _setupWindDown();

        vm.prank(randomUser);
        vm.expectRevert("ArmadaTreasuryGov: not wind-down");
        treasury.transferTo(address(usdc), recipient, 100e6);
    }

    function test_transferTo_revertsZeroRecipient() public {
        _setupWindDown();

        vm.prank(windDown);
        vm.expectRevert("ArmadaTreasuryGov: zero recipient");
        treasury.transferTo(address(usdc), address(0), 100e6);
    }

    function test_transferTo_bypassesOutflowLimits() public {
        _setupWindDown();

        // Initialize very tight outflow limits
        vm.prank(timelockAddr);
        treasury.initOutflowConfig(address(usdc), 30 days, 100, 1e6, 1e6); // 1% or $1 absolute

        // Transfer entire balance (way over the limit) — should succeed
        uint256 fullBalance = usdc.balanceOf(address(treasury));
        vm.prank(windDown);
        treasury.transferTo(address(usdc), recipient, fullBalance);

        assertEq(usdc.balanceOf(recipient), fullBalance);
    }

    // ======== transferETHTo ========

    function test_transferETHTo_windDownOnly() public {
        _setupWindDown();
        _fundTreasuryETH(5 ether);

        vm.prank(windDown);
        vm.expectEmit(true, false, false, true);
        emit WindDownETHTransfer(recipient, 5 ether);
        treasury.transferETHTo(payable(recipient), 5 ether);

        assertEq(recipient.balance, 5 ether);
    }

    function test_transferETHTo_revertsForNonWindDown() public {
        _setupWindDown();
        _fundTreasuryETH(5 ether);

        vm.prank(randomUser);
        vm.expectRevert("ArmadaTreasuryGov: not wind-down");
        treasury.transferETHTo(payable(recipient), 5 ether);
    }

    function test_transferETHTo_revertsZeroRecipient() public {
        _setupWindDown();
        _fundTreasuryETH(5 ether);

        vm.prank(windDown);
        vm.expectRevert("ArmadaTreasuryGov: zero recipient");
        treasury.transferETHTo(payable(address(0)), 5 ether);
    }

    // ======== Treasury can receive ETH ========

    function test_treasuryCanReceiveETH() public {
        _fundTreasuryETH(10 ether);
        assertEq(address(treasury).balance, 10 ether);
    }

    // ======== Helpers ========

    function _setupWindDown() internal {
        vm.prank(timelockAddr);
        treasury.setWindDownContract(windDown);
    }

    function _fundTreasuryETH(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool success,) = address(treasury).call{value: amount}("");
        require(success, "ETH transfer failed");
    }
}
