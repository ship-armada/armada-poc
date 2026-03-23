// ABOUTME: Foundry tests for steward pass-by-default proposals, self-payment filter, and budget management.
// ABOUTME: Covers the governor-based steward proposal flow where proposals pass unless community actively defeats them.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/governance/TreasurySteward.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal mock ERC20 for budget tests
contract MockToken is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title GovernorStewardTest — Tests for steward pass-by-default proposals and budget enforcement
contract GovernorStewardTest is Test {
    // Mirror events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        ProposalType proposalType,
        uint256 voteStart,
        uint256 voteEnd,
        string description
    );
    event StewardContractSet(address indexed steward);
    event StewardBudgetTokenAdded(address indexed token, uint256 limit, uint256 window);

    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public stewardContract;
    MockToken public usdc;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public stewardPerson = address(0xDA7E);
    address public windDown = address(0xD00D);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant BOND_AMOUNT = 1_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;
    uint256 constant MAX_PAUSE = 14 days;
    uint256 constant BUDGET_LIMIT = 10_000 * 1e6; // 10,000 USDC
    uint256 constant BUDGET_WINDOW = 30 days;

    function setUp() public {
        // Deploy timelock
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        // Deploy ARM token
        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy treasury
        treasury = new ArmadaTreasuryGov(address(timelock), deployer, MAX_PAUSE);

        // Deploy governor
        governor = new ArmadaGovernor(
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            deployer,
            MAX_PAUSE
        );

        // Deploy steward contract
        stewardContract = new TreasurySteward(
            address(timelock),
            deployer,
            MAX_PAUSE
        );

        // Register steward contract on governor
        governor.setStewardContract(address(stewardContract));

        // Whitelist addresses for ARM transfers
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = address(governor);
        whitelist[3] = stewardPerson;
        armToken.initWhitelist(whitelist);

        // Distribute tokens
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 50 / 100);

        // Delegate voting power
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        // Advance block for checkpoint availability
        vm.roll(block.number + 1);

        // Deploy mock USDC and fund treasury
        usdc = new MockToken();
        usdc.mint(address(treasury), 1_000_000 * 1e6);

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));

        // Elect steward person (this contract acts as timelock for the steward contract)
        // The steward contract's timelock is the real timelock, so we prank as timelock
        vm.prank(address(timelock));
        stewardContract.electSteward(stewardPerson);
    }

    // ======== Helpers ========

    /// @dev Create a steward proposal for stewardSpend
    function _proposeStewardSpend(address recipient, uint256 amount) internal returns (uint256) {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "stewardSpend(address,address,uint256)",
            address(usdc), recipient, amount
        );

        vm.prank(stewardPerson);
        return governor.proposeStewardAction(targets, values, calldatas, "steward spend");
    }

    /// @dev Fast-forward past voting period and check state
    function _passVotingPeriod(uint256 proposalId) internal {
        // Steward proposals have 0 voting delay, 7d voting period
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Core: Pass-by-default
    // ══════════════════════════════════════════════════════════════════════

    function test_stewardProposal_passesWithNoVotes() public {
        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);
        _passVotingPeriod(proposalId);

        // No votes at all → Succeeded (pass-by-default)
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
    }

    function test_stewardProposal_passesWithQuorumAndMajorityFor() public {
        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);

        // Alice votes FOR
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR

        _passVotingPeriod(proposalId);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
    }

    function test_stewardProposal_defeatedWhenQuorumMetAndMajorityAgainst() public {
        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);

        // Both vote AGAINST (quorum met + majority against)
        vm.prank(alice);
        governor.castVote(proposalId, 0); // AGAINST
        vm.prank(bob);
        governor.castVote(proposalId, 0); // AGAINST

        _passVotingPeriod(proposalId);

        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Defeated));
    }

    function test_stewardProposal_passesWithBelowQuorumAgainstVotes() public {
        // Create a small voter (5% of eligible supply = well below 20% quorum)
        // Eligible supply = total - treasury = 6M. Quorum = 20% of 6M = 1.2M
        address smallVoter = address(0xBEE);
        uint256 smallAmount = 500_000 * 1e18; // 500k < 1.2M quorum
        // Transfer from deployer's remaining tokens
        armToken.transfer(smallVoter, smallAmount);
        vm.prank(smallVoter);
        armToken.delegate(smallVoter);
        vm.roll(block.number + 1);

        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);

        // Only the small voter votes against — below quorum
        vm.prank(smallVoter);
        governor.castVote(proposalId, 0); // AGAINST

        _passVotingPeriod(proposalId);

        // Quorum not met → passes by default (NOT defeated)
        assertEq(uint256(governor.state(proposalId)), uint256(ProposalState.Succeeded));
    }

    // ══════════════════════════════════════════════════════════════════════
    // Access control
    // ══════════════════════════════════════════════════════════════════════

    function test_proposeStewardAction_rejectsNonSteward() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), alice, 100);

        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not current steward");
        governor.proposeStewardAction(targets, values, calldatas, "test");
    }

    function test_proposeStewardAction_rejectsExpiredSteward() public {
        // Warp past 6-month term
        vm.warp(block.timestamp + 181 days);

        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), alice, 100);

        vm.prank(stewardPerson);
        vm.expectRevert("ArmadaGovernor: steward not active");
        governor.proposeStewardAction(targets, values, calldatas, "test");
    }

    function test_proposeStewardAction_rejectsRemovedSteward() public {
        vm.prank(address(timelock));
        stewardContract.removeSteward();

        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), alice, 100);

        vm.prank(stewardPerson);
        vm.expectRevert("ArmadaGovernor: not current steward");
        governor.proposeStewardAction(targets, values, calldatas, "test");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Type guards
    // ══════════════════════════════════════════════════════════════════════

    function test_propose_rejectsStewardType() public {
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: auto-created only");
        governor.propose(ProposalType.Steward, targets, values, calldatas, "sneak steward");
    }

    function test_setProposalTypeParams_rejectsStewardType() public {
        ProposalParams memory params = ProposalParams({
            votingDelay: 1 days,
            votingPeriod: 7 days,
            executionDelay: 2 days,
            quorumBps: 2000
        });

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaGovernor: immutable proposal type");
        governor.setProposalTypeParams(ProposalType.Steward, params);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Self-payment filter
    // ══════════════════════════════════════════════════════════════════════

    function test_selfPaymentFilter_blocksStewdSpendToSteward() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "stewardSpend(address,address,uint256)",
            address(usdc), stewardPerson, 100
        );

        vm.prank(stewardPerson);
        vm.expectRevert("ArmadaGovernor: self-payment not allowed");
        governor.proposeStewardAction(targets, values, calldatas, "self pay");
    }

    function test_selfPaymentFilter_blocksDistributeToSteward() public {
        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature(
            "distribute(address,address,uint256)",
            address(usdc), stewardPerson, 100
        );

        vm.prank(stewardPerson);
        vm.expectRevert("ArmadaGovernor: self-payment not allowed");
        governor.proposeStewardAction(targets, values, calldatas, "self distribute");
    }

    function test_selfPaymentFilter_allowsNonStewardRecipient() public {
        // Should not revert when recipient is not the steward
        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);
        assertTrue(proposalId > 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Wind-down blocks steward proposals
    // ══════════════════════════════════════════════════════════════════════

    function test_proposeStewardAction_blockedByWindDown() public {
        // Setup wind-down
        vm.prank(address(timelock));
        governor.setWindDownContract(windDown);
        vm.prank(windDown);
        governor.setWindDownActive();

        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), alice, 100);

        vm.prank(stewardPerson);
        vm.expectRevert("ArmadaGovernor: governance ended");
        governor.proposeStewardAction(targets, values, calldatas, "test");
    }

    // ══════════════════════════════════════════════════════════════════════
    // setStewardContract
    // ══════════════════════════════════════════════════════════════════════

    function test_setStewardContract_locksAfterFirstCall() public {
        // Already called in setUp, so second call should revert
        vm.expectRevert("ArmadaGovernor: already locked");
        governor.setStewardContract(address(0xBEEF));
    }

    function test_setStewardContract_rejectsNonDeployer() public {
        // Deploy a fresh governor to test before lock
        ArmadaGovernor freshGovernor = new ArmadaGovernor(
            address(armToken),
            payable(address(timelock)),
            address(treasury),
            deployer,
            MAX_PAUSE
        );

        vm.prank(alice);
        vm.expectRevert("ArmadaGovernor: not deployer");
        freshGovernor.setStewardContract(address(stewardContract));
    }

    // ══════════════════════════════════════════════════════════════════════
    // Budget management on treasury
    // ══════════════════════════════════════════════════════════════════════

    function test_addStewardBudgetToken_success() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        (uint256 limit, uint256 window, bool authorized) = treasury.stewardBudgets(address(usdc));
        assertEq(limit, BUDGET_LIMIT);
        assertEq(window, BUDGET_WINDOW);
        assertTrue(authorized);
    }

    function test_addStewardBudgetToken_rejectsAlreadyAuthorized() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaTreasuryGov: token already authorized");
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);
    }

    function test_updateStewardBudgetToken_success() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        uint256 newLimit = BUDGET_LIMIT * 2;
        vm.prank(address(timelock));
        treasury.updateStewardBudgetToken(address(usdc), newLimit, BUDGET_WINDOW);

        (uint256 limit,,) = treasury.stewardBudgets(address(usdc));
        assertEq(limit, newLimit);
    }

    function test_removeStewardBudgetToken_success() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        vm.prank(address(timelock));
        treasury.removeStewardBudgetToken(address(usdc));

        (,, bool authorized) = treasury.stewardBudgets(address(usdc));
        assertFalse(authorized);
    }

    function test_budgetFunctions_rejectNonOwner() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaTreasuryGov: not owner");
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);
    }

    function test_stewardSpend_withinBudget() public {
        // Setup budget via timelock
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        uint256 spendAmount = BUDGET_LIMIT / 2;

        // stewardSpend is now onlyOwner (timelock calls it)
        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, spendAmount);

        assertEq(usdc.balanceOf(alice), spendAmount);
        assertEq(treasury.stewardBudgetSpent(address(usdc)), spendAmount);
    }

    function test_stewardSpend_exceedsBudget() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        vm.prank(address(timelock));
        vm.expectRevert("ArmadaTreasuryGov: exceeds steward budget");
        treasury.stewardSpend(address(usdc), alice, BUDGET_LIMIT + 1);
    }

    function test_stewardSpend_unauthorizedToken() public {
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaTreasuryGov: token not authorized for steward");
        treasury.stewardSpend(address(usdc), alice, 100);
    }

    function test_stewardSpend_budgetWindowResets() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        // Spend full budget
        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, BUDGET_LIMIT);

        // Can't spend more in same window
        vm.prank(address(timelock));
        vm.expectRevert("ArmadaTreasuryGov: exceeds steward budget");
        treasury.stewardSpend(address(usdc), alice, 1);

        // Warp past window
        vm.warp(block.timestamp + BUDGET_WINDOW + 1);

        // Can spend again after window reset
        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, BUDGET_LIMIT);

        assertEq(usdc.balanceOf(alice), BUDGET_LIMIT * 2);
    }

    function test_stewardSpend_multipleSpendsSameWindow() public {
        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), BUDGET_LIMIT, BUDGET_WINDOW);

        // Spend in 3 transactions
        uint256 spend1 = BUDGET_LIMIT / 3;
        uint256 spend2 = BUDGET_LIMIT / 3;
        uint256 spend3 = BUDGET_LIMIT / 3;

        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, spend1);
        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, spend2);
        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, spend3);

        assertEq(treasury.stewardBudgetSpent(address(usdc)), spend1 + spend2 + spend3);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_passByDefault_passesUnlessQuorumAndMajorityAgainst(
        uint256 forVotes,
        uint256 againstVotes
    ) public {
        // Bound: alice has 20% of supply, bob has 15%
        uint256 aliceVP = TOTAL_SUPPLY * 20 / 100;
        uint256 bobVP = TOTAL_SUPPLY * 15 / 100;

        // 0 = no vote, 1 = for, 2 = against
        forVotes = bound(forVotes, 0, 2);
        againstVotes = bound(againstVotes, 0, 2);

        uint256 proposalId = _proposeStewardSpend(alice, 100 * 1e6);

        // Cast votes based on fuzz params
        if (forVotes == 1) {
            vm.prank(alice);
            governor.castVote(proposalId, 1); // FOR
        } else if (forVotes == 2) {
            vm.prank(alice);
            governor.castVote(proposalId, 0); // AGAINST (alice votes against in "for" slot)
        }

        if (againstVotes == 1) {
            vm.prank(bob);
            governor.castVote(proposalId, 0); // AGAINST
        } else if (againstVotes == 2) {
            vm.prank(bob);
            governor.castVote(proposalId, 1); // FOR
        }

        _passVotingPeriod(proposalId);

        ProposalState s = governor.state(proposalId);

        // Calculate expected result
        uint256 totalFor;
        uint256 totalAgainst;
        if (forVotes == 1) totalFor += aliceVP;
        else if (forVotes == 2) totalAgainst += aliceVP;
        if (againstVotes == 1) totalAgainst += bobVP;
        else if (againstVotes == 2) totalFor += bobVP;

        uint256 quorumNeeded = governor.quorum(proposalId);
        uint256 totalParticipation = totalFor + totalAgainst;

        bool quorumMet = totalParticipation >= quorumNeeded;
        bool majorityAgainst = totalAgainst > totalFor;

        if (quorumMet && majorityAgainst) {
            assertEq(uint256(s), uint256(ProposalState.Defeated), "should be defeated");
        } else {
            assertEq(uint256(s), uint256(ProposalState.Succeeded), "should succeed (pass-by-default)");
        }
    }

    function testFuzz_nonStewardRejected(address caller) public {
        vm.assume(caller != stewardPerson);
        vm.assume(caller != address(0));

        address[] memory targets = new address[](1);
        targets[0] = address(treasury);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("stewardSpend(address,address,uint256)", address(usdc), alice, 100);

        vm.prank(caller);
        vm.expectRevert("ArmadaGovernor: not current steward");
        governor.proposeStewardAction(targets, values, calldatas, "test");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Budget fuzz
    // ══════════════════════════════════════════════════════════════════════

    function testFuzz_budgetArithmetic(uint256 spend1, uint256 spend2) public {
        uint256 limit = 1_000_000 * 1e6; // 1M
        spend1 = bound(spend1, 1, limit);
        spend2 = bound(spend2, 0, limit);

        // Fund treasury with enough USDC
        usdc.mint(address(treasury), limit * 2);

        vm.prank(address(timelock));
        treasury.addStewardBudgetToken(address(usdc), limit, BUDGET_WINDOW);

        vm.prank(address(timelock));
        treasury.stewardSpend(address(usdc), alice, spend1);

        if (spend1 + spend2 > limit) {
            vm.prank(address(timelock));
            vm.expectRevert("ArmadaTreasuryGov: exceeds steward budget");
            treasury.stewardSpend(address(usdc), alice, spend2);
        } else if (spend2 > 0) {
            vm.prank(address(timelock));
            treasury.stewardSpend(address(usdc), alice, spend2);

            // Verify: spent + remaining = limit
            uint256 spent = treasury.stewardBudgetSpent(address(usdc));
            assertEq(spent, spend1 + spend2);
            (uint256 budget, uint256 viewSpent, uint256 remaining) = treasury.getStewardBudget(address(usdc));
            assertEq(budget, limit);
            assertEq(viewSpent, spent);
            assertEq(remaining, limit - spent);
        }
    }
}
