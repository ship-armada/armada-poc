// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for governor extended classification, proposal bond, and wind-down features.
// ABOUTME: Covers mechanical selector-based classification, ARM bond lifecycle, and wind-down governance shutdown.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./helpers/GovernorDeployHelper.sol";

/// @dev Minimal mock ERC20 for treasury balance checks in classification tests
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title GovernorClassificationBondWindDownTest — Tests for extended classification, bond mechanism, and wind-down
contract GovernorClassificationBondWindDownTest is Test, GovernorDeployHelper {
    // Mirror events from governor for expectEmit
    event WindDownActivated();

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    MockUSDC public usdc;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public windDown = address(0xD00D);
    address public securityCouncil = address(0x5C5C);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant BOND_AMOUNT = 1_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;
    uint256 constant FOURTEEN_DAYS = 14 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock));

        // Deploy governor
        governor = _deployGovernorProxy(
            address(armToken),
            payable(address(timelock)),
            address(treasury)
        );

        // Setup: whitelist deployer so they can transfer tokens
        address[] memory whitelist = new address[](3);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = address(governor);
        armToken.initWhitelist(whitelist);

        // Distribute tokens: alice gets 20%, bob gets 15%, treasury gets rest
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 50 / 100);

        // Delegate to activate voting power
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        // Advance block so checkpoints are available
        vm.roll(block.number + 1);

        // Deploy mock USDC for treasury balance tests
        usdc = new MockUSDC();

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
    }

    // ======== Helpers ========

    /// @dev Enable ARM transfers and approve governor for bond on behalf of proposer
    function _enableTransfersAndApproveBond(address proposer) internal {
        armToken.setWindDownContract(windDown);
        vm.prank(windDown);
        armToken.setTransferable(true);

        vm.prank(proposer);
        armToken.approve(address(governor), BOND_AMOUNT);
    }

    function _proposeStandard(address proposer) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(proposer);
        return governor.propose(ProposalType.Standard, targets, values, calldatas, "test");
    }

    function _proposeWithCalldata(
        address proposer,
        ProposalType pType,
        address target,
        bytes memory data
    ) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = target;
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = data;

        vm.prank(proposer);
        return governor.propose(pType, targets, values, calldatas, "test");
    }

    // ═══════════════════════════════════════════════════════════════
    // WIND-DOWN INTEGRATION
    // ═══════════════════════════════════════════════════════════════

    function test_windDown_proposeRevertsWhenActive() public {
        // Register wind-down contract via timelock
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);

        // Activate wind-down
        vm.prank(windDown);
        governor.setWindDownActive();

        assertTrue(governor.windDownActive());

        // Proposing should revert
        vm.expectRevert("ArmadaGovernor: governance ended");
        _proposeStandard(alice);
    }

    function test_windDown_onlyWindDownContractCanActivate() public {
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);

        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not wind-down contract");
        governor.setWindDownActive();
    }

    function test_windDown_cannotActivateBeforeSet() public {
        // windDownContract is address(0); random caller should fail
        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not wind-down contract");
        governor.setWindDownActive();
    }

    function test_windDown_cannotSetContractTwice() public {
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: wind-down contract already set");
        governor.setWindDownContract(address(0x999));
    }

    function test_windDown_onlyTimelockCanSetContract() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.setWindDownContract(windDown);
    }

    function test_windDown_cannotActivateTwice() public {
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);

        vm.prank(windDown);
        governor.setWindDownActive();

        vm.prank(windDown);
        vm.expectRevert("ArmadaGovernor: wind-down already active");
        governor.setWindDownActive();
    }

    function test_windDown_existingProposalsContinue() public {
        // Create a proposal before wind-down
        uint256 proposalId = _proposeStandard(alice);

        // Activate wind-down
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);
        vm.prank(windDown);
        governor.setWindDownActive();

        // The existing proposal should still be in Pending state and voteable
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Pending));

        // Advance to voting period
        vm.warp(block.timestamp + TWO_DAYS + 1);
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Active));

        // Alice can still vote
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR
    }

    function test_windDown_emitsEvent() public {
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);

        vm.prank(windDown);
        vm.expectEmit(true, true, true, true);
        emit WindDownActivated();
        governor.setWindDownActive();
    }

    // ═══════════════════════════════════════════════════════════════
    // MECHANICAL EXTENDED PROPOSAL CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════

    function test_classify_registeredSelectorForcesExtended() public {
        // setProposalTypeParams is registered as extended in constructor
        bytes memory data = abi.encodeWithSelector(
            governor.setProposalTypeParams.selector,
            ProposalType.Standard,
            ProposalParams(2 days, 7 days, 2 days, 2000)
        );

        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(governor), data);

        // Check it was classified as Extended
        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Extended));
    }

    function test_classify_unregisteredSelectorStaysStandard() public {
        // proposalCount() is not registered as extended
        bytes memory data = abi.encodeWithSignature("proposalCount()");
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(governor), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Standard));
    }

    function test_classify_voluntaryExtendedPreserved() public {
        // Proposer declares Extended voluntarily with standard calldata
        bytes memory data = abi.encodeWithSignature("proposalCount()");
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Extended, address(governor), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Extended));
    }

    function test_classify_mixedCalldataExtendedWins() public {
        // One standard call + one extended call → Extended
        address[] memory targets = new address[](2);
        targets[0] = address(governor);
        targets[1] = address(governor);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = abi.encodeWithSignature("proposalCount()"); // standard
        calldatas[1] = abi.encodeWithSelector( // extended (governance param change)
            governor.setProposalTypeParams.selector,
            ProposalType.Standard,
            ProposalParams(2 days, 7 days, 2 days, 2000)
        );

        vm.prank(alice);
        uint256 proposalId = governor.propose(ProposalType.Standard, targets, values, calldatas, "mixed");

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Extended));
    }

    function test_classify_resumeStewardChannelIsStandard() public {
        // resumeStewardChannel is NOT registered as an extended selector,
        // so proposals targeting it should be classified as Standard.
        assertFalse(governor.extendedSelectors(governor.resumeStewardChannel.selector));

        bytes memory data = abi.encodeWithSelector(governor.resumeStewardChannel.selector);
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(governor), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Standard));
    }

    function test_classify_addExtendedSelector() public {
        bytes4 newSelector = bytes4(keccak256("someNewFunction(uint256)"));

        // Not extended yet
        assertFalse(governor.extendedSelectors(newSelector));

        // Add via timelock
        vm.prank(address(timelock));
        governor.addExtendedSelector(newSelector);

        assertTrue(governor.extendedSelectors(newSelector));

        // Now proposals with this selector should be Extended
        bytes memory data = abi.encodeWithSelector(newSelector, uint256(42));
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(governor), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Extended));
    }

    function test_classify_removeExtendedSelector() public {
        // setProposalTypeParams is registered; remove it
        vm.prank(address(timelock));
        governor.removeExtendedSelector(governor.setProposalTypeParams.selector);

        assertFalse(governor.extendedSelectors(governor.setProposalTypeParams.selector));
    }

    function test_classify_onlyTimelockCanAddSelector() public {
        bytes4 selector = bytes4(keccak256("test()"));
        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.addExtendedSelector(selector);
    }

    function test_classify_onlyTimelockCanRemoveSelector() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.removeExtendedSelector(governor.setProposalTypeParams.selector);
    }

    function test_classify_addExtendedSelectorIsItself_Extended() public {
        // addExtendedSelector's own selector is registered as extended in constructor
        assertTrue(governor.extendedSelectors(governor.addExtendedSelector.selector));
    }

    function test_classify_securityCouncilSelectorIsExtended() public {
        assertTrue(governor.extendedSelectors(governor.setSecurityCouncil.selector));
    }

    function test_classify_distributeLargeAmountForcesExtended() public {
        // Put USDC in treasury so we can test the 5% check
        usdc.mint(address(treasury), 1_000_000e6); // $1M in treasury

        // Distribute 60,000 USDC (6% > 5% threshold) → Extended
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("distribute(address,address,uint256)")),
            address(usdc),
            alice,
            60_000e6
        );
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(treasury), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Extended));
    }

    function test_classify_distributeSmallAmountStaysStandard() public {
        usdc.mint(address(treasury), 1_000_000e6);

        // Distribute 40,000 USDC (4% < 5% threshold) → Standard
        bytes memory data = abi.encodeWithSelector(
            bytes4(keccak256("distribute(address,address,uint256)")),
            address(usdc),
            alice,
            40_000e6
        );
        uint256 proposalId = _proposeWithCalldata(alice, ProposalType.Standard, address(treasury), data);

        (,ProposalType pType,,,,,,, ) = governor.getProposal(proposalId);
        assertEq(uint256(pType), uint256(ProposalType.Standard));
    }

    // ═══════════════════════════════════════════════════════════════
    // SECURITY COUNCIL STATE
    // ═══════════════════════════════════════════════════════════════

    function test_securityCouncil_setByTimelock() public {
        vm.prank(address(timelock));
        governor.setSecurityCouncil(securityCouncil);
        assertEq(governor.securityCouncil(), securityCouncil);
    }

    function test_securityCouncil_onlyTimelockCanSet() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not timelock");
        governor.setSecurityCouncil(securityCouncil);
    }

    function test_securityCouncil_canSetToZeroForEjection() public {
        vm.prank(address(timelock));
        governor.setSecurityCouncil(securityCouncil);

        vm.prank(address(timelock));
        governor.setSecurityCouncil(address(0));
        assertEq(governor.securityCouncil(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    // PROPOSAL BOND
    // ═══════════════════════════════════════════════════════════════

    function test_bond_notRequiredWhenNonTransferable() public {
        // ARM is non-transferable by default — propose should work without bond
        uint256 proposalId = _proposeStandard(alice);
        assertGt(proposalId, 0);

        // No bond recorded
        (address depositor, uint256 amount,,) = governor.proposalBonds(proposalId);
        assertEq(depositor, address(0));
        assertEq(amount, 0);
    }

    function test_bond_requiredWhenTransferable() public {
        _enableTransfersAndApproveBond(alice);

        uint256 aliceBalBefore = armToken.balanceOf(alice);
        uint256 proposalId = _proposeStandard(alice);

        // Bond was taken
        uint256 aliceBalAfter = armToken.balanceOf(alice);
        assertEq(aliceBalBefore - aliceBalAfter, BOND_AMOUNT);

        // Bond info recorded
        (address depositor, uint256 amount,,) = governor.proposalBonds(proposalId);
        assertEq(depositor, alice);
        assertEq(amount, BOND_AMOUNT);
    }

    function test_bond_revertsWithoutApproval() public {
        armToken.setWindDownContract(windDown);
        vm.prank(windDown);
        armToken.setTransferable(true);

        // Alice does NOT approve governor
        vm.expectRevert(); // ERC20: insufficient allowance
        _proposeStandard(alice);
    }

    function test_bond_claimAfterExecution() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        // Fast-forward through voting delay
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Vote FOR
        vm.prank(alice);
        governor.castVote(proposalId, 1);
        vm.prank(bob);
        governor.castVote(proposalId, 1);

        // Fast-forward past voting period
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // Queue
        governor.queue(proposalId);

        // Fast-forward past execution delay
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Execute
        governor.execute(proposalId);

        // Claim bond — should be immediately available
        uint256 aliceBalBefore = armToken.balanceOf(alice);
        governor.claimBond(proposalId);
        uint256 aliceBalAfter = armToken.balanceOf(alice);
        assertEq(aliceBalAfter - aliceBalBefore, BOND_AMOUNT);
    }

    function test_bond_claimAfterCancel() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        // Cancel during Pending
        vm.prank(alice);
        governor.cancel(proposalId);

        // Claim bond — immediately available
        uint256 aliceBalBefore = armToken.balanceOf(alice);
        governor.claimBond(proposalId);
        assertEq(armToken.balanceOf(alice) - aliceBalBefore, BOND_AMOUNT);
    }

    function test_bond_lockedOnQuorumFail() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        // Fast-forward past voting delay + voting period with NO votes → quorum not met
        vm.warp(block.timestamp + TWO_DAYS + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Defeated));

        // Try to claim immediately → should revert (locked 15 days)
        vm.expectRevert("ArmadaGovernor: bond still locked");
        governor.claimBond(proposalId);

        // Fast-forward 15 days → now claimable
        vm.warp(block.timestamp + 15 days);
        governor.claimBond(proposalId);
    }

    function test_bond_lockedOnVoteDown() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        // Fast-forward past voting delay
        vm.warp(block.timestamp + TWO_DAYS + 1);

        // Vote AGAINST with enough to reach quorum
        vm.prank(alice);
        governor.castVote(proposalId, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(proposalId, 0); // AGAINST

        // Fast-forward past voting period
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Defeated));

        // Try to claim immediately → locked 45 days
        vm.expectRevert("ArmadaGovernor: bond still locked");
        governor.claimBond(proposalId);

        // Fast-forward 45 days → now claimable
        vm.warp(block.timestamp + 45 days);
        governor.claimBond(proposalId);
    }

    function test_bond_cannotClaimTwice() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        vm.prank(alice);
        governor.cancel(proposalId);

        governor.claimBond(proposalId);

        vm.expectRevert("ArmadaGovernor: bond already claimed");
        governor.claimBond(proposalId);
    }

    function test_bond_cannotClaimActiveProposal() public {
        _enableTransfersAndApproveBond(alice);

        uint256 proposalId = _proposeStandard(alice);

        // Still Pending — not terminal
        vm.expectRevert("ArmadaGovernor: proposal not in terminal state");
        governor.claimBond(proposalId);
    }

    function test_bond_noBondReverts() public {
        // Propose without bond (non-transferable)
        uint256 proposalId = _proposeStandard(alice);

        vm.expectRevert("ArmadaGovernor: no bond");
        governor.claimBond(proposalId);
    }
}
