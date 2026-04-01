// ABOUTME: Foundry tests for the steward circuit breaker that pauses the steward channel
// ABOUTME: after 5 consecutive steward proposals with participation below 30%.

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
import "./helpers/GovernorDeployHelper.sol";

/// @dev Minimal mock ERC20 for tests
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @title GovernorCircuitBreakerTest — Steward channel circuit breaker tests
contract GovernorCircuitBreakerTest is Test, GovernorDeployHelper {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    TimelockController public timelock;
    ArmadaTreasuryGov public treasury;
    TreasurySteward public stewardContract;
    MockUSDC public usdc;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public stewardPerson = address(0xDA7E);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;
    uint256 constant SEVEN_DAYS = 7 days;

    event StewardChannelPaused(uint256 indexed triggeringProposalId);
    event StewardChannelResumed();

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

        // Deploy steward contract
        stewardContract = new TreasurySteward(address(timelock));

        // Register steward contract on governor
        governor.setStewardContract(address(stewardContract));

        // Whitelist addresses for ARM transfers
        address[] memory whitelist = new address[](4);
        whitelist[0] = deployer;
        whitelist[1] = alice;
        whitelist[2] = address(governor);
        whitelist[3] = stewardPerson;
        armToken.initWhitelist(whitelist);

        // Distribute tokens: alice 20%, bob 15%, treasury 50%, deployer keeps 15%
        armToken.transfer(alice, TOTAL_SUPPLY * 20 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(treasury), TOTAL_SUPPLY * 50 / 100);

        // Delegate voting power
        vm.prank(alice);
        armToken.delegate(alice);
        vm.prank(bob);
        armToken.delegate(bob);

        vm.roll(block.number + 1);

        // Deploy mock USDC and fund treasury
        usdc = new MockUSDC();
        usdc.mint(address(treasury), 1_000_000 * 1e6);

        // Grant timelock roles to governor
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));
        timelock.grantRole(timelock.CANCELLER_ROLE(), address(governor));

        // Elect steward
        vm.prank(address(timelock));
        stewardContract.electSteward(stewardPerson);
    }

    // ======== Helpers ========

    function _createStewardProposal() internal returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100 * 1e6;

        vm.prank(stewardPerson);
        return governor.proposeStewardSpend(tokens, recipients, amounts, "steward spend");
    }

    /// @dev Create a steward proposal, warp past voting, resolve it (no votes = low participation)
    function _createAndResolveLowParticipation() internal returns (uint256) {
        uint256 proposalId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveStewardProposal(proposalId);
        return proposalId;
    }

    /// @dev Create a steward proposal with alice voting (20% participation > 30% threshold? no)
    /// Alice has 20% of total supply but eligible supply = total - treasury = 50%.
    /// So alice's 20% of total = 20/50 = 40% of eligible. That's above 30%.
    function _createAndResolveHighParticipation() internal returns (uint256) {
        uint256 proposalId = _createStewardProposal();
        vm.prank(alice);
        governor.castVote(proposalId, 1); // FOR
        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveStewardProposal(proposalId);
        return proposalId;
    }

    // ══════════════════════════════════════════════════════════════════════
    // Core: 5 consecutive low-participation proposals trigger pause
    // ══════════════════════════════════════════════════════════════════════

    function test_circuitBreaker_triggersAfter5LowParticipation() public {
        // First 4 don't trigger
        for (uint256 i = 0; i < 4; i++) {
            _createAndResolveLowParticipation();
            assertFalse(governor.stewardChannelPaused(), "should not be paused yet");
            assertEq(governor.consecutiveLowParticipationCount(), i + 1);
        }

        // 5th triggers the pause
        _createAndResolveLowParticipation();
        assertTrue(governor.stewardChannelPaused(), "should be paused after 5");
        assertEq(governor.consecutiveLowParticipationCount(), 5);
    }

    function test_circuitBreaker_highParticipationResetsCounter() public {
        // 3 low participation
        for (uint256 i = 0; i < 3; i++) {
            _createAndResolveLowParticipation();
        }
        assertEq(governor.consecutiveLowParticipationCount(), 3);

        // 1 high participation resets
        _createAndResolveHighParticipation();
        assertEq(governor.consecutiveLowParticipationCount(), 0);
        assertFalse(governor.stewardChannelPaused());
    }

    function test_circuitBreaker_counterResetsAndRestarts() public {
        // 4 low, 1 high (resets), then 5 low → should trigger
        for (uint256 i = 0; i < 4; i++) {
            _createAndResolveLowParticipation();
        }
        _createAndResolveHighParticipation();
        assertEq(governor.consecutiveLowParticipationCount(), 0);

        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }
        assertTrue(governor.stewardChannelPaused());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Paused channel blocks new proposals
    // ══════════════════════════════════════════════════════════════════════

    function test_circuitBreaker_blocksNewStewardProposals() public {
        // Trigger circuit breaker
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }
        assertTrue(governor.stewardChannelPaused());

        // Try to create a new steward proposal
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100 * 1e6;

        vm.prank(stewardPerson);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_StewardChannelPaused.selector));
        governor.proposeStewardSpend(tokens, recipients, amounts, "blocked");
    }

    // ══════════════════════════════════════════════════════════════════════
    // Governance can resume
    // ══════════════════════════════════════════════════════════════════════

    function test_circuitBreaker_governanceCanResume() public {
        // Trigger circuit breaker
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }
        assertTrue(governor.stewardChannelPaused());

        // Resume via timelock (governance)
        vm.prank(address(timelock));
        governor.resumeStewardChannel();

        assertFalse(governor.stewardChannelPaused());
        assertEq(governor.consecutiveLowParticipationCount(), 0);
    }

    function test_circuitBreaker_resumeAllowsNewProposals() public {
        // Trigger then resume
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }
        vm.prank(address(timelock));
        governor.resumeStewardChannel();

        // Should be able to create proposals again
        uint256 proposalId = _createStewardProposal();
        assertTrue(proposalId > 0);
    }

    function test_circuitBreaker_counterResetsAfterResume() public {
        // Trigger, resume, then need 5 more to trigger again
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }
        vm.prank(address(timelock));
        governor.resumeStewardChannel();

        // 4 low should NOT trigger
        for (uint256 i = 0; i < 4; i++) {
            _createAndResolveLowParticipation();
        }
        assertFalse(governor.stewardChannelPaused());

        // 5th triggers again
        _createAndResolveLowParticipation();
        assertTrue(governor.stewardChannelPaused());
    }

    // ══════════════════════════════════════════════════════════════════════
    // Access control
    // ══════════════════════════════════════════════════════════════════════

    function test_resumeStewardChannel_rejectsNonTimelock() public {
        // Trigger circuit breaker
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotTimelock.selector));
        governor.resumeStewardChannel();
    }

    function test_resumeStewardChannel_rejectsWhenNotPaused() public {
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotPaused.selector));
        governor.resumeStewardChannel();
    }

    // ══════════════════════════════════════════════════════════════════════
    // resolveStewardProposal guards
    // ══════════════════════════════════════════════════════════════════════

    function test_resolve_rejectsNonStewardProposal() public {
        // Create a standard proposal
        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()");

        vm.prank(alice);
        uint256 proposalId = governor.propose(
            ProposalType.Standard, targets, values, calldatas, "standard proposal"
        );

        vm.warp(block.timestamp + TWO_DAYS + SEVEN_DAYS + 1);

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_NotStewardProposal.selector));
        governor.resolveStewardProposal(proposalId);
    }

    function test_resolve_rejectsBeforeVotingEnds() public {
        uint256 proposalId = _createStewardProposal();

        // Voting hasn't ended yet
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_VotingNotEnded.selector));
        governor.resolveStewardProposal(proposalId);
    }

    function test_resolve_rejectsDoubleResolve() public {
        uint256 proposalId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        governor.resolveStewardProposal(proposalId);

        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_AlreadyResolved.selector));
        governor.resolveStewardProposal(proposalId);
    }

    function test_resolve_rejectsUnknownProposal() public {
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_UnknownProposal.selector));
        governor.resolveStewardProposal(999);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Participation boundary
    // ══════════════════════════════════════════════════════════════════════

    function test_circuitBreaker_exactlyAt30PercentIsNotLow() public {
        // Eligible supply = total - treasury(50%) = 6M ARM.
        // 30% of 6M = 1.8M ARM. Bob has 15% of 12M = 1.8M ARM exactly.
        // Bob voting should put participation at exactly 30%.
        uint256 proposalId = _createStewardProposal();
        vm.prank(bob);
        governor.castVote(proposalId, 2); // ABSTAIN — still counts as participation

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveStewardProposal(proposalId);

        // Exactly at 30% should NOT count as low participation
        assertEq(governor.consecutiveLowParticipationCount(), 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Events
    // ══════════════════════════════════════════════════════════════════════

    function test_circuitBreaker_emitsPausedEvent() public {
        for (uint256 i = 0; i < 4; i++) {
            _createAndResolveLowParticipation();
        }

        uint256 fifthId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        vm.expectEmit(true, false, false, false);
        emit StewardChannelPaused(fifthId);
        governor.resolveStewardProposal(fifthId);
    }

    function test_circuitBreaker_emitsResumedEvent() public {
        for (uint256 i = 0; i < 5; i++) {
            _createAndResolveLowParticipation();
        }

        vm.prank(address(timelock));
        vm.expectEmit(false, false, false, false);
        emit StewardChannelResumed();
        governor.resumeStewardChannel();
    }

    // ══════════════════════════════════════════════════════════════════════
    // Fuzz: participation boundary
    // ══════════════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════════════
    // Auto-resolve: proposeStewardSpend resolves prior proposals automatically
    // ══════════════════════════════════════════════════════════════════════

    function test_autoResolve_resolvesPriorProposals() public {
        // Create a proposal, warp past voting, then create another.
        // The first should be auto-resolved by the second call.
        uint256 firstId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        assertFalse(governor.stewardProposalResolved(firstId), "should not be resolved yet");

        // Creating a new proposal auto-resolves the first
        _createStewardProposal();

        assertTrue(governor.stewardProposalResolved(firstId), "should be auto-resolved");
        assertEq(governor.consecutiveLowParticipationCount(), 1, "low participation counted");
    }

    function test_autoResolve_triggersCircuitBreaker() public {
        // Create 5 low-participation proposals without warping between them
        // (so none get auto-resolved during creation). Then warp past all voting,
        // and the 6th attempt should auto-resolve all 5 and revert.
        uint256[] memory ids = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) {
            ids[i] = _createStewardProposal();
        }

        // Warp past all voting periods at once
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // None resolved yet
        for (uint256 i = 0; i < 5; i++) {
            assertFalse(governor.stewardProposalResolved(ids[i]));
        }
        assertFalse(governor.stewardChannelPaused());

        // 6th proposal attempt should auto-resolve all 5 and then revert
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 100 * 1e6;

        vm.prank(stewardPerson);
        vm.expectRevert(abi.encodeWithSelector(ArmadaGovernor.Gov_StewardChannelPaused.selector));
        governor.proposeStewardSpend(tokens, recipients, amounts, "should fail");
    }

    function test_autoResolve_stopsAtActiveVoting() public {
        // Create proposal #1, warp past voting. Create #2 (still in voting).
        // Creating #3 should only auto-resolve #1, not #2.
        uint256 firstId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        uint256 secondId = _createStewardProposal();
        // Only a small warp — second proposal's voting is still active
        vm.warp(block.timestamp + 1 days);

        uint256 thirdId = _createStewardProposal();

        assertTrue(governor.stewardProposalResolved(firstId), "first should be resolved");
        assertFalse(governor.stewardProposalResolved(secondId), "second still in voting");
        assertFalse(governor.stewardProposalResolved(thirdId), "third just created");
        // Only first was low-participation
        assertEq(governor.consecutiveLowParticipationCount(), 1);
    }

    function test_autoResolve_skipsAlreadyResolved() public {
        // Create proposal, warp, manually resolve it, then create another.
        // Auto-resolve should skip the already-resolved one without error.
        uint256 firstId = _createStewardProposal();
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // Manually resolve
        governor.resolveStewardProposal(firstId);
        assertEq(governor.consecutiveLowParticipationCount(), 1);

        // Creating a new proposal should succeed without double-resolution issues
        uint256 secondId = _createStewardProposal();
        assertTrue(secondId > firstId);
        // Counter should still be 1 (not incremented again)
        assertEq(governor.consecutiveLowParticipationCount(), 1);
    }

    function test_autoResolve_highParticipationResetsCounter() public {
        // Create 3 low-participation proposals and 1 high-participation proposal
        // without warping between them (so none auto-resolve during creation).
        // Then warp and create a 5th — auto-resolve should process all 4,
        // with the high-participation one resetting the counter.
        for (uint256 i = 0; i < 3; i++) {
            _createStewardProposal();
        }

        // 4th proposal: alice votes (40% of eligible > 30% threshold)
        uint256 highPartId = _createStewardProposal();
        vm.prank(alice);
        governor.castVote(highPartId, 1); // FOR

        // Warp past all voting periods at once
        vm.warp(block.timestamp + SEVEN_DAYS + 1);

        // None resolved yet
        assertEq(governor.consecutiveLowParticipationCount(), 0);

        // 5th proposal auto-resolves all 4 prior proposals
        _createStewardProposal();

        // 3 low → counter=3, then 1 high → counter=0
        assertEq(governor.consecutiveLowParticipationCount(), 0);
        assertFalse(governor.stewardChannelPaused());
    }

    function testFuzz_participationThreshold(uint256 aliceVote, uint256 bobVote) public {
        // 0 = no vote, 1 = FOR, 2 = AGAINST, 3 = ABSTAIN
        aliceVote = bound(aliceVote, 0, 3);
        bobVote = bound(bobVote, 0, 3);

        uint256 proposalId = _createStewardProposal();

        if (aliceVote > 0) {
            uint8 voteType = aliceVote == 1 ? 1 : (aliceVote == 2 ? 0 : 2);
            vm.prank(alice);
            governor.castVote(proposalId, voteType);
        }
        if (bobVote > 0) {
            uint8 voteType = bobVote == 1 ? 1 : (bobVote == 2 ? 0 : 2);
            vm.prank(bob);
            governor.castVote(proposalId, voteType);
        }

        vm.warp(block.timestamp + SEVEN_DAYS + 1);
        governor.resolveStewardProposal(proposalId);

        // Calculate expected participation
        // Eligible supply = totalSupply - treasury balance = 6M
        // Alice = 2.4M (20%), Bob = 1.8M (15%), deployer = 1.8M (15%)
        // As fraction of eligible: Alice = 40%, Bob = 30%
        uint256 aliceWeight = aliceVote > 0 ? TOTAL_SUPPLY * 20 / 100 : 0;
        uint256 bobWeight = bobVote > 0 ? TOTAL_SUPPLY * 15 / 100 : 0;
        uint256 totalVotes = aliceWeight + bobWeight;

        // Eligible supply at snapshot
        uint256 eligibleSupply = TOTAL_SUPPLY - (TOTAL_SUPPLY * 50 / 100); // minus treasury
        uint256 participationBps = eligibleSupply > 0
            ? (totalVotes * 10000) / eligibleSupply
            : 0;

        if (participationBps < 3000) {
            assertEq(governor.consecutiveLowParticipationCount(), 1);
        } else {
            assertEq(governor.consecutiveLowParticipationCount(), 0);
        }
    }
}
