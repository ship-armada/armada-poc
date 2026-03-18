// ABOUTME: Foundry fuzz tests for ArmadaCrowdfund.permissionlessCancel() grace period boundary.
// ABOUTME: Verifies the function reverts before the grace period and succeeds after.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

contract ArmadaCrowdfundCancelTest is Test {
    ArmadaCrowdfund public crowdfund;
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public caller;

    uint256 constant THIRTY_DAYS = 30 days;

    function setUp() public {
        admin = address(this);
        caller = address(0xBEEF);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            admin,
            address(0xCAFE), // treasury
            admin
        );

        // Fund ARM for MAX_SALE
        armToken.transfer(address(crowdfund), 1_800_000 * 1e18);

        // Start invitations to set commitmentEnd
        address[] memory seeds = new address[](1);
        seeds[0] = address(0xA);
        crowdfund.addSeeds(seeds);
        crowdfund.startInvitations();
    }

    /// @notice permissionlessCancel always reverts when elapsed <= FINALIZE_GRACE_PERIOD
    function testFuzz_revertsBeforeGracePeriod(uint256 elapsed) public {
        uint256 commitmentEnd = crowdfund.commitmentEnd();
        // Bound elapsed to [0, FINALIZE_GRACE_PERIOD] (inclusive — should revert at boundary)
        elapsed = bound(elapsed, 0, THIRTY_DAYS);

        vm.warp(commitmentEnd + elapsed);

        vm.prank(caller);
        vm.expectRevert("ArmadaCrowdfund: grace period not elapsed");
        crowdfund.permissionlessCancel();
    }

    /// @notice permissionlessCancel always succeeds when elapsed > FINALIZE_GRACE_PERIOD
    function testFuzz_succeedsAfterGracePeriod(uint256 elapsed) public {
        uint256 commitmentEnd = crowdfund.commitmentEnd();
        // Bound elapsed to (FINALIZE_GRACE_PERIOD, FINALIZE_GRACE_PERIOD + 365 days]
        elapsed = bound(elapsed, THIRTY_DAYS + 1, THIRTY_DAYS + 365 days);

        vm.warp(commitmentEnd + elapsed);

        vm.prank(caller);
        crowdfund.permissionlessCancel();

        assertEq(uint256(crowdfund.phase()), uint256(Phase.Canceled));
    }
}
