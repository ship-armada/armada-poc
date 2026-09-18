// SPDX-License-Identifier: MIT
// ABOUTME: Pre-funding permission checks for the immutable reserve distributor.
// ABOUTME: Uses real ARM initialization to exercise permanent misconfiguration paths.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/RevenueReserveDistributor.sol";
import "../contracts/governance/RevenueLock.sol";
import "../contracts/governance/ArmadaToken.sol";

contract RevenueReserveIntegrationTest is Test {
    ArmadaToken internal token;
    RevenueLock internal lock;
    RevenueReserveDistributor internal distributor;

    function setUp() public {
        token = new ArmadaToken(address(this), address(this));
        distributor = new RevenueReserveDistributor(address(token), address(0xA110C), 360_000e18);
        address[] memory recipients = new address[](1);
        recipients[0] = address(distributor);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 360_000e18;
        // No revenue reads occur in a pre-funding check.
        lock = new RevenueLock(address(token), address(0xC017), 10_000e18, recipients, amounts);
    }

    function _initialize(uint8 flags, uint8 fault) internal {
        if (flags & 1 != 0) {
            address[] memory whitelist = new address[](2);
            whitelist[0] = fault == 1 ? address(this) : address(distributor);
            whitelist[1] = fault == 2 ? address(this) : address(lock);
            token.initWhitelist(whitelist);
        }
        if (flags & 2 != 0) {
            address[] memory delegators = new address[](1);
            delegators[0] = fault == 3 ? address(this) : fault == 4 ? address(distributor) : address(lock);
            token.initAuthorizedDelegators(delegators);
        }
        if (flags & 4 != 0) {
            address[] memory blocked = new address[](1);
            blocked[0] = fault == 5 ? address(distributor) : address(0x7EA5);
            token.initNoDelegation(blocked);
        }
    }

    // WHY: The gate must pass before irreversible funding or activation, not require them first.
    function test_validIntegrationBeforeFunding() public {
        distributor.bindRevenueLock(address(lock));
        _initialize(7, 0);
        assertTrue(distributor.verifyIntegration());
        assertEq(token.balanceOf(address(lock)), 0);
        assertFalse(lock.activated());
    }

    // WHY: Funding while unbound must be caught while the deployer can still abandon the setup.
    function test_unboundRejected() public {
        _initialize(7, 0);
        vm.expectRevert(RevenueReserveDistributor.NotBound.selector);
        distributor.verifyIntegration();
    }

    // WHY: A not-yet-initialized noDelegation mapping looks safe but can later permanently brick release.
    function testFuzz_incompleteInitializationRejected(uint8 flags) public {
        flags = uint8(bound(flags, 0, 6));
        distributor.bindRevenueLock(address(lock));
        _initialize(flags, 0);
        vm.expectRevert(RevenueReserveDistributor.IncompleteTokenSetup.selector);
        distributor.verifyIntegration();
    }

    // WHY: Each source/destination permission mistake must be rejected before any ARM enters the lock.
    function testFuzz_invalidPermissionsRejected(uint8 fault) public {
        fault = uint8(bound(fault, 1, 5));
        distributor.bindRevenueLock(address(lock));
        _initialize(7, fault);
        vm.expectRevert(RevenueReserveDistributor.InvalidIntegration.selector);
        distributor.verifyIntegration();
    }

    // WHY: Even with source authorization intact, the distributor must never gain authority over other wallets.
    function test_distributorDelegatorPrivilegeRejected() public {
        distributor.bindRevenueLock(address(lock));
        _initialize(7, 0);
        token.addAuthorizedDelegator(address(distributor));
        vm.expectRevert(RevenueReserveDistributor.InvalidIntegration.selector);
        distributor.verifyIntegration();
    }
}
