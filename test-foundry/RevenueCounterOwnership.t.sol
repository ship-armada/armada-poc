// SPDX-License-Identifier: MIT
// ABOUTME: Foundry fuzz tests for RevenueCounter's ownership lock — ownership is fixed at initialization.
// ABOUTME: Proves no caller can transfer or renounce ownership, so the upgrade authority cannot be handed off.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/RevenueCounter.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract RevenueCounterOwnershipTest is Test {
    RevenueCounter internal counter;
    address internal constant OWNER = address(0xA11CE);

    function setUp() public {
        RevenueCounter impl = new RevenueCounter();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(RevenueCounter.initialize, (OWNER))
        );
        counter = RevenueCounter(address(proxy));
    }

    // WHY: the owner (timelock) holds the UUPS upgrade authority. A hand-off would let the
    // new owner upgrade with no vote and no upgrade-gate approval, so it must fail for
    // every caller — the owner included — and for every recipient.
    function testFuzz_transferOwnershipAlwaysReverts(address caller, address newOwner) public {
        vm.prank(caller);
        vm.expectRevert("RevenueCounter: ownership is fixed");
        counter.transferOwnership(newOwner);
        assertEq(counter.owner(), OWNER);
    }

    function testFuzz_renounceOwnershipAlwaysReverts(address caller) public {
        vm.prank(caller);
        vm.expectRevert("RevenueCounter: ownership is fixed");
        counter.renounceOwnership();
        assertEq(counter.owner(), OWNER);
    }

    function test_ownerStillUpgrades() public {
        RevenueCounter newImpl = new RevenueCounter();
        vm.prank(OWNER);
        counter.upgradeTo(address(newImpl));
        assertEq(counter.owner(), OWNER);
    }
}
