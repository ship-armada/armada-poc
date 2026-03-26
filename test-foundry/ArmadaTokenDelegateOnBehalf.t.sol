// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ArmadaToken.delegateOnBehalf and initAuthorizedDelegators.
// ABOUTME: Covers authorization setup, on-behalf delegation, voting power transfer, and guard interactions.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

contract ArmadaTokenDelegateOnBehalfTest is Test {
    // Mirror events
    event AuthorizedDelegatorsInitialized(address[] delegators);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);

    ArmadaToken public armToken;
    TimelockController public timelock;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public carol = address(0xCA401);
    address public authorizedContract = address(0xAC01);
    address public unauthorizedCaller = address(0xBAD);
    address public treasuryAddr = address(0x7EA5);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(2 days, proposers, executors, deployer);

        // Deploy ARM token (deployer receives full supply)
        armToken = new ArmadaToken(deployer, address(timelock));

        // Whitelist deployer + alice + bob so transfers work
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = bob;
        whitelist[3] = carol;
        armToken.initWhitelist(whitelist);

        // Set treasury as noDelegation
        armToken.setNoDelegation(treasuryAddr);

        // Distribute tokens
        armToken.transfer(alice, 2_000_000 * 1e18);
        armToken.transfer(bob, 1_000_000 * 1e18);
        armToken.transfer(carol, 500_000 * 1e18);

        // Mine a block so getPastVotes works
        vm.roll(block.number + 1);
    }

    // ============ initAuthorizedDelegators ============

    function test_initAuthorizedDelegators_succeeds() public {
        address[] memory delegators = new address[](2);
        delegators[0] = authorizedContract;
        delegators[1] = address(0xAC02);

        vm.expectEmit(false, false, false, true);
        emit AuthorizedDelegatorsInitialized(delegators);

        armToken.initAuthorizedDelegators(delegators);

        assertTrue(armToken.authorizedDelegator(authorizedContract));
        assertTrue(armToken.authorizedDelegator(address(0xAC02)));
        assertFalse(armToken.authorizedDelegator(unauthorizedCaller));
        assertTrue(armToken.authorizedDelegatorsInitialized());
    }

    function test_initAuthorizedDelegators_notDeployer_reverts() public {
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;

        vm.prank(alice);
        vm.expectRevert("ArmadaToken: not deployer");
        armToken.initAuthorizedDelegators(delegators);
    }

    function test_initAuthorizedDelegators_calledTwice_reverts() public {
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;

        armToken.initAuthorizedDelegators(delegators);

        vm.expectRevert("ArmadaToken: delegators already initialized");
        armToken.initAuthorizedDelegators(delegators);
    }

    function test_initAuthorizedDelegators_zeroAddress_reverts() public {
        address[] memory delegators = new address[](2);
        delegators[0] = authorizedContract;
        delegators[1] = address(0);

        vm.expectRevert("ArmadaToken: zero address");
        armToken.initAuthorizedDelegators(delegators);
    }

    // ============ delegateOnBehalf ============

    function test_delegateOnBehalf_authorized_succeeds() public {
        // Setup: authorize the contract
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // Alice has tokens but hasn't delegated yet — zero voting power
        assertEq(armToken.getVotes(alice), 0);
        assertEq(armToken.getVotes(bob), 0);

        // Authorized contract delegates alice's tokens to bob
        vm.prank(authorizedContract);
        armToken.delegateOnBehalf(alice, bob);

        // Bob now has alice's voting power
        assertEq(armToken.getVotes(bob), 2_000_000 * 1e18);
        assertEq(armToken.delegates(alice), bob);
    }

    function test_delegateOnBehalf_unauthorized_reverts() public {
        // No authorized delegators set up
        vm.prank(unauthorizedCaller);
        vm.expectRevert("ArmadaToken: not authorized delegator");
        armToken.delegateOnBehalf(alice, bob);
    }

    function test_delegateOnBehalf_unauthorizedAfterInit_reverts() public {
        // Setup: authorize a different contract
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // Unauthorized caller still blocked
        vm.prank(unauthorizedCaller);
        vm.expectRevert("ArmadaToken: not authorized delegator");
        armToken.delegateOnBehalf(alice, bob);
    }

    function test_delegateOnBehalf_noDelegation_reverts() public {
        // Setup: authorize the contract
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // Try to delegate on behalf of treasury (noDelegation address)
        vm.prank(authorizedContract);
        vm.expectRevert("ArmadaToken: delegation blocked");
        armToken.delegateOnBehalf(treasuryAddr, bob);
    }

    function test_delegateOnBehalf_emitsDelegateChanged() public {
        // Setup
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // Expect the OZ DelegateChanged event
        vm.expectEmit(true, true, true, false);
        emit DelegateChanged(alice, address(0), bob);

        vm.prank(authorizedContract);
        armToken.delegateOnBehalf(alice, bob);
    }

    function test_delegateOnBehalf_changesDelegatee() public {
        // Setup
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // First delegation: alice -> bob
        vm.prank(authorizedContract);
        armToken.delegateOnBehalf(alice, bob);
        assertEq(armToken.delegates(alice), bob);
        assertEq(armToken.getVotes(bob), 2_000_000 * 1e18);

        // Second delegation: alice -> carol
        vm.prank(authorizedContract);
        armToken.delegateOnBehalf(alice, carol);
        assertEq(armToken.delegates(alice), carol);
        assertEq(armToken.getVotes(carol), 2_000_000 * 1e18);
        assertEq(armToken.getVotes(bob), 0);
    }

    function test_delegateOnBehalf_selfDelegation() public {
        // Setup
        address[] memory delegators = new address[](1);
        delegators[0] = authorizedContract;
        armToken.initAuthorizedDelegators(delegators);

        // Self-delegation is valid per spec
        vm.prank(authorizedContract);
        armToken.delegateOnBehalf(alice, alice);
        assertEq(armToken.delegates(alice), alice);
        assertEq(armToken.getVotes(alice), 2_000_000 * 1e18);
    }
}
