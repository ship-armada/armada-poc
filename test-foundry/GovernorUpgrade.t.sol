// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ArmadaGovernor UUPS upgradeability.
// ABOUTME: Covers upgrade authorization, state persistence, re-init prevention, and storage compatibility.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @title ArmadaGovernorV2Mock — Minimal V2 for testing upgrade + state persistence
contract ArmadaGovernorV2Mock is ArmadaGovernor {
    uint256 public newV2Variable;

    function setNewV2Variable(uint256 val) external {
        require(msg.sender == address(timelock), "not timelock");
        newV2Variable = val;
    }

    function v2Marker() external pure returns (string memory) {
        return "v2";
    }
}

/// @title GovernorUpgradeTest — UUPS upgrade lifecycle tests
contract GovernorUpgradeTest is Test, GovernorDeployHelper {

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public attacker = address(0xBAD);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock));

        // Deploy governor behind proxy
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));

        // Setup token distribution
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = bob;
        whitelist[3] = address(treasury);
        armToken.initWhitelist(whitelist);

        armToken.transfer(alice, TOTAL_SUPPLY * 40 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 20 / 100);

        // Delegate (activate voting power)
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);
        vm.roll(block.number + 1);
    }

    // ============ Upgrade Authorization ============

    function test_upgrade_viaTimelockSucceeds() public {
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();

        // Upgrade via timelock
        vm.prank(address(timelock));
        governor.upgradeTo(address(v2Impl));

        // Verify V2 is active
        ArmadaGovernorV2Mock upgraded = ArmadaGovernorV2Mock(address(governor));
        assertEq(upgraded.v2Marker(), "v2");
    }

    function test_upgrade_fromNonTimelockReverts() public {
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();

        vm.prank(attacker);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.upgradeTo(address(v2Impl));
    }

    function test_upgrade_fromDeployerReverts() public {
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();

        vm.prank(deployer);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.upgradeTo(address(v2Impl));
    }

    // ============ State Persistence ============

    function test_upgrade_statePersistsAcrossUpgrade() public {
        // Set some state before upgrade
        governor.setStewardContract(address(0x1234));

        // Set security council via timelock
        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0x5C5C));

        // Verify pre-upgrade state
        assertEq(address(governor.armToken()), address(armToken));
        assertEq(address(governor.timelock()), address(timelock));
        assertEq(governor.treasuryAddress(), address(treasury));
        assertEq(governor.stewardContract(), address(0x1234));
        assertEq(governor.securityCouncil(), address(0x5C5C));

        // Upgrade
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();
        vm.prank(address(timelock));
        governor.upgradeTo(address(v2Impl));

        // Verify all state persists
        assertEq(address(governor.armToken()), address(armToken));
        assertEq(address(governor.timelock()), address(timelock));
        assertEq(governor.treasuryAddress(), address(treasury));
        assertEq(governor.stewardContract(), address(0x1234));
        assertEq(governor.securityCouncil(), address(0x5C5C));
        assertTrue(governor.stewardContractLocked());

        // Verify V2 functionality works
        ArmadaGovernorV2Mock upgraded = ArmadaGovernorV2Mock(address(governor));
        vm.prank(address(timelock));
        upgraded.setNewV2Variable(42);
        assertEq(upgraded.newV2Variable(), 42);
    }

    function test_upgrade_proposalTypeParamsPersist() public {
        // Check proposal params before upgrade
        (uint256 delay, uint256 period, uint256 execDelay, uint256 quorum) =
            governor.proposalTypeParams(ProposalType.Standard);
        assertEq(delay, 2 days);
        assertEq(period, 7 days);
        assertEq(execDelay, 2 days);
        assertEq(quorum, 2000);

        // Upgrade
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();
        vm.prank(address(timelock));
        governor.upgradeTo(address(v2Impl));

        // Verify params persist
        (delay, period, execDelay, quorum) =
            governor.proposalTypeParams(ProposalType.Standard);
        assertEq(delay, 2 days);
        assertEq(period, 7 days);
        assertEq(execDelay, 2 days);
        assertEq(quorum, 2000);
    }

    function test_upgrade_adapterRegistryPersists() public {
        // Authorize an adapter
        vm.prank(address(timelock));
        governor.authorizeAdapter(address(0xADA));
        assertTrue(governor.authorizedAdapters(address(0xADA)));

        // Upgrade
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();
        vm.prank(address(timelock));
        governor.upgradeTo(address(v2Impl));

        // Verify adapter state persists
        assertTrue(governor.authorizedAdapters(address(0xADA)));
    }

    // ============ Initialization Guards ============

    function test_initialize_cannotReinitialize() public {
        vm.expectRevert("Initializable: contract is already initialized");
        governor.initialize(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );
    }

    function test_initialize_implementationCannotBeInitialized() public {
        ArmadaGovernor impl = new ArmadaGovernor();

        vm.expectRevert("Initializable: contract is already initialized");
        impl.initialize(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );
    }

    // ============ Extended Classification ============

    function test_upgrade_selectorIsExtended() public {
        // upgradeTo selector should be classified as extended
        assertTrue(governor.extendedSelectors(bytes4(keccak256("upgradeTo(address)"))));
        assertTrue(governor.extendedSelectors(bytes4(keccak256("upgradeToAndCall(address,bytes)"))));
    }

    // ============ Wind-Down State Persistence ============

    function test_upgrade_windDownStatePersists() public {
        // Set wind-down contract via timelock
        vm.prank(address(timelock));
        governor.setWindDownContract(address(0xD00D));
        assertTrue(governor.windDownContractSet());

        // Upgrade
        ArmadaGovernorV2Mock v2Impl = new ArmadaGovernorV2Mock();
        vm.prank(address(timelock));
        governor.upgradeTo(address(v2Impl));

        // Verify wind-down state persists
        assertEq(governor.windDownContract(), address(0xD00D));
        assertTrue(governor.windDownContractSet());
        assertFalse(governor.windDownActive());
    }
}
