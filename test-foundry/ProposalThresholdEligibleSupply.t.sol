// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title ProposalThresholdEligibleSupplyTest
/// @notice Tests that proposal threshold uses eligible supply (excluding treasury and
///         excluded addresses), not raw totalSupply. Covers audit finding H-8.
contract ProposalThresholdEligibleSupplyTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;

    uint256 constant TOTAL_SUPPLY = 100_000_000 * 1e18;
    uint256 constant THRESHOLD_BPS = 10; // 0.1%

    address public treasury = address(0xBABE);
    address public crowdfund = address(0xCF01);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    function setUp() public {
        armToken = new ArmadaToken(address(this));

        address[] memory proposers = new address[](1);
        proposers[0] = address(0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(1 days, proposers, executors, address(this));

        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));

        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            treasury,
            address(this),
            14 days
        );

        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    function _lockTokens(address user, uint256 amount) internal {
        armToken.transfer(user, amount);
        vm.startPrank(user);
        armToken.approve(address(locker), amount);
        locker.lock(amount);
        vm.stopPrank();
        vm.roll(block.number + 2);
    }

    function _propose(address proposer) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        return governor.propose(
            ProposalType.ParameterChange,
            targets, values, calldatas,
            "Test proposal"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // Unit: threshold reflects eligible supply, not totalSupply
    // ═══════════════════════════════════════════════════════════════════

    function test_thresholdUsesEligibleSupply_noExclusions() public view {
        // No tokens sent to treasury or excluded addresses yet.
        // Eligible supply == total supply, so threshold == 0.1% of 100M = 100k ARM
        uint256 threshold = governor.proposalThreshold();
        uint256 expected = (TOTAL_SUPPLY * THRESHOLD_BPS) / 10000;
        assertEq(threshold, expected, "Threshold should be 0.1% of total when no exclusions");
    }

    function test_thresholdDecreasesWithTreasuryBalance() public {
        // Send 65M ARM to treasury (65% of supply)
        uint256 treasuryAmount = 65_000_000 * 1e18;
        armToken.transfer(treasury, treasuryAmount);

        uint256 eligibleSupply = TOTAL_SUPPLY - treasuryAmount; // 35M
        uint256 expected = (eligibleSupply * THRESHOLD_BPS) / 10000;
        uint256 threshold = governor.proposalThreshold();
        assertEq(threshold, expected, "Threshold should be 0.1% of eligible (35M)");

        // Verify it's lower than it would be with totalSupply
        uint256 totalSupplyThreshold = (TOTAL_SUPPLY * THRESHOLD_BPS) / 10000;
        assertLt(threshold, totalSupplyThreshold, "Threshold should be less than totalSupply-based");
    }

    function test_thresholdDecreasesWithExcludedAddresses() public {
        // Send tokens to treasury and crowdfund, then register crowdfund as excluded
        uint256 treasuryAmount = 50_000_000 * 1e18;
        uint256 crowdfundAmount = 15_000_000 * 1e18;
        armToken.transfer(treasury, treasuryAmount);
        armToken.transfer(crowdfund, crowdfundAmount);

        address[] memory excluded = new address[](1);
        excluded[0] = crowdfund;
        governor.setExcludedAddresses(excluded);

        uint256 eligibleSupply = TOTAL_SUPPLY - treasuryAmount - crowdfundAmount; // 35M
        uint256 expected = (eligibleSupply * THRESHOLD_BPS) / 10000;
        assertEq(governor.proposalThreshold(), expected, "Threshold should exclude both treasury and crowdfund");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Unit: propose() enforces the eligible-supply-based threshold
    // ═══════════════════════════════════════════════════════════════════

    function test_proposeBelowEligibleThresholdReverts() public {
        // Send 65M to treasury. Eligible = 35M. Threshold = 35k ARM.
        uint256 treasuryAmount = 65_000_000 * 1e18;
        armToken.transfer(treasury, treasuryAmount);

        uint256 threshold = governor.proposalThreshold();

        // Lock exactly 1 token below threshold
        _lockTokens(alice, threshold - 1);

        vm.expectRevert("ArmadaGovernor: below proposal threshold");
        _propose(alice);
    }

    function test_proposeAtExactEligibleThresholdSucceeds() public {
        // Send 65M to treasury. Eligible = 35M. Threshold = 35k ARM.
        uint256 treasuryAmount = 65_000_000 * 1e18;
        armToken.transfer(treasury, treasuryAmount);

        uint256 threshold = governor.proposalThreshold();

        // Lock exactly at threshold
        _lockTokens(alice, threshold);

        uint256 proposalId = _propose(alice);
        assertGt(proposalId, 0, "Proposal should have been created");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Scenario: user who would pass totalSupply threshold but not
    // eligible-supply threshold cannot propose
    // ═══════════════════════════════════════════════════════════════════

    function test_thresholdConsistencyBetweenViewAndPropose() public {
        // Send tokens to treasury + excluded
        armToken.transfer(treasury, 50_000_000 * 1e18);
        armToken.transfer(crowdfund, 20_000_000 * 1e18);

        address[] memory excluded = new address[](1);
        excluded[0] = crowdfund;
        governor.setExcludedAddresses(excluded);

        uint256 threshold = governor.proposalThreshold();

        // Lock exactly threshold for alice
        _lockTokens(alice, threshold);
        _propose(alice); // should succeed

        // Lock 1 less than threshold for bob
        _lockTokens(bob, threshold - 1);
        vm.expectRevert("ArmadaGovernor: below proposal threshold");
        _propose(bob);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: threshold always <= totalSupply-based threshold
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_thresholdAlwaysLteTotal(uint256 treasuryPct) public {
        // treasury gets 0-99% of supply
        treasuryPct = bound(treasuryPct, 0, 99);
        uint256 treasuryAmount = (TOTAL_SUPPLY * treasuryPct) / 100;
        if (treasuryAmount > 0) {
            armToken.transfer(treasury, treasuryAmount);
        }

        uint256 threshold = governor.proposalThreshold();
        uint256 totalThreshold = (TOTAL_SUPPLY * THRESHOLD_BPS) / 10000;
        assertLe(threshold, totalThreshold, "Eligible threshold must be <= totalSupply threshold");
    }

    function testFuzz_thresholdEqualsExpected(uint256 treasuryPct, uint256 excludedPct) public {
        treasuryPct = bound(treasuryPct, 0, 50);
        excludedPct = bound(excludedPct, 0, 49);
        // Ensure total excluded < 100%
        vm.assume(treasuryPct + excludedPct < 100);

        uint256 treasuryAmount = (TOTAL_SUPPLY * treasuryPct) / 100;
        uint256 excludedAmount = (TOTAL_SUPPLY * excludedPct) / 100;

        if (treasuryAmount > 0) armToken.transfer(treasury, treasuryAmount);
        if (excludedAmount > 0) armToken.transfer(crowdfund, excludedAmount);

        address[] memory excluded = new address[](1);
        excluded[0] = crowdfund;
        governor.setExcludedAddresses(excluded);

        uint256 eligibleSupply = TOTAL_SUPPLY - treasuryAmount - excludedAmount;
        uint256 expected = (eligibleSupply * THRESHOLD_BPS) / 10000;
        assertEq(governor.proposalThreshold(), expected, "Threshold must match eligible supply formula");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Fuzz: propose succeeds iff locked >= threshold (eligible supply)
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_proposeRespectsEligibleThreshold(uint256 treasuryPct, uint256 lockAmount) public {
        treasuryPct = bound(treasuryPct, 10, 90);
        uint256 treasuryAmount = (TOTAL_SUPPLY * treasuryPct) / 100;
        armToken.transfer(treasury, treasuryAmount);

        uint256 threshold = governor.proposalThreshold();
        // Lock between 1 and 2x the threshold
        lockAmount = bound(lockAmount, 1, threshold * 2);

        // Ensure deployer has enough to give alice
        uint256 deployerBalance = armToken.balanceOf(address(this));
        vm.assume(lockAmount <= deployerBalance);

        _lockTokens(alice, lockAmount);

        if (lockAmount >= threshold) {
            // Should succeed
            uint256 pid = _propose(alice);
            assertGt(pid, 0);
        } else {
            // Should revert
            vm.expectRevert("ArmadaGovernor: below proposal threshold");
            _propose(alice);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Property: threshold and quorum use the same eligible supply
    // ═══════════════════════════════════════════════════════════════════

    function test_thresholdAndQuorumUseSameEligibleSupply() public {
        uint256 treasuryAmount = 60_000_000 * 1e18;
        armToken.transfer(treasury, treasuryAmount);
        armToken.transfer(crowdfund, 10_000_000 * 1e18);

        address[] memory excluded = new address[](1);
        excluded[0] = crowdfund;
        governor.setExcludedAddresses(excluded);

        uint256 eligibleSupply = TOTAL_SUPPLY - treasuryAmount - 10_000_000 * 1e18; // 30M

        // Lock enough for alice to propose
        _lockTokens(alice, 1_000_000 * 1e18);

        uint256 proposalId = _propose(alice);

        // quorum = eligibleSupply * quorumBps / 10000
        // For ParameterChange: quorumBps = 2000 (20%)
        uint256 expectedQuorum = (eligibleSupply * 2000) / 10000;
        assertEq(governor.quorum(proposalId), expectedQuorum, "Quorum should use same eligible supply");

        // threshold = eligibleSupply * 10 / 10000
        uint256 expectedThreshold = (eligibleSupply * THRESHOLD_BPS) / 10000;
        assertEq(governor.proposalThreshold(), expectedThreshold, "Threshold should use same eligible supply");
    }
}
