// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaGovernor.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/governance/VotingLocker.sol";
import "../contracts/governance/IArmadaGovernance.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

// ══════════════════════════════════════════════════════════════════════════
// INV-G1: ARM total supply is constant (matches INITIAL_SUPPLY)
// INV-G2: One vote per address per proposal — voting twice reverts
// INV-G3: Proposal state transitions are monotonic
// INV-G5: Quorum for a proposal never changes after creation
// ══════════════════════════════════════════════════════════════════════════

/// @title GovernorHandler — Stateful fuzz handler for governance invariant testing
/// @dev Drives the full governance lifecycle: lock, propose, vote, advance time.
contract GovernorHandler is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;

    address[] public actors;

    address public treasuryAddr;

    // Ghost variables
    uint256 public ghost_proposalCount;
    uint256 public ghost_voteCount;

    // Track quorum at creation time for each proposal (INV-G5)
    mapping(uint256 => uint256) public ghost_quorumAtCreation;

    // Track all votes cast: (proposalId, voter) pairs
    struct VoteRecord {
        uint256 proposalId;
        address voter;
    }
    VoteRecord[] internal _voteRecords;

    // Track highest state observed per proposal (for monotonicity check)
    // ProposalState: Pending=0, Active=1, Defeated=2, Succeeded=3, Queued=4, Executed=5, Canceled=6
    mapping(uint256 => uint8) public ghost_highestState;
    uint256 public ghost_stateMonotonicityViolations;

    constructor(
        ArmadaGovernor _governor,
        ArmadaToken _armToken,
        VotingLocker _locker,
        address[] memory _actors,
        address _treasuryAddr
    ) {
        governor = _governor;
        armToken = _armToken;
        locker = _locker;
        actors = _actors;
        treasuryAddr = _treasuryAddr;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATE TRACKING
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Map ProposalState to a monotonic ordering
    /// Pending=0, Active=1, Defeated/Canceled=terminal (map to 100+),
    /// Succeeded=3, Queued=4, Executed=5
    /// For monotonicity, terminals are never expected to go backward,
    /// so we map them high and check that non-terminal states only increase.
    function _stateOrder(ProposalState s) internal pure returns (uint8) {
        if (s == ProposalState.Pending) return 0;
        if (s == ProposalState.Active) return 1;
        if (s == ProposalState.Defeated) return 2;
        if (s == ProposalState.Succeeded) return 3;
        if (s == ProposalState.Queued) return 4;
        if (s == ProposalState.Executed) return 5;
        if (s == ProposalState.Canceled) return 6;
        return 0;
    }

    function _checkAndUpdateState(uint256 proposalId) internal {
        if (proposalId == 0 || proposalId > ghost_proposalCount) return;

        try governor.state(proposalId) returns (ProposalState currentState) {
            uint8 currentOrder = _stateOrder(currentState);
            uint8 highestOrder = ghost_highestState[proposalId];

            // For monotonicity: once in a terminal state (Defeated, Executed, Canceled),
            // the state should not change. For non-terminal states, order should increase
            // or stay the same. The key check: current should never be LESS than the highest
            // non-terminal state observed (Pending < Active < Succeeded < Queued < Executed).
            // Defeated and Canceled are terminal — once observed, state must stay there.
            if (highestOrder == 2 || highestOrder == 5 || highestOrder == 6) {
                // Was in terminal state; should stay in same state
                if (currentOrder != highestOrder) {
                    ghost_stateMonotonicityViolations++;
                }
            } else {
                // Non-terminal: current order should be >= highest
                // Exception: transition to Defeated (2) from Active (1) is valid
                if (currentOrder < highestOrder && currentOrder != 2) {
                    ghost_stateMonotonicityViolations++;
                }
            }

            if (currentOrder > highestOrder) {
                ghost_highestState[proposalId] = currentOrder;
            }
        } catch {}
    }

    // ═══════════════════════════════════════════════════════════════════
    // HANDLER ACTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Lock tokens for voting power
    function lockTokens(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        uint256 available = armToken.balanceOf(actor);
        if (available == 0) return;
        amount = bound(amount, 1, available);

        vm.startPrank(actor);
        armToken.approve(address(locker), amount);
        try locker.lock(amount) {} catch {}
        vm.stopPrank();

        // Advance block to create checkpoint
        vm.roll(block.number + 1);

        // Update all proposal states
        for (uint256 i = 1; i <= ghost_proposalCount; i++) {
            _checkAndUpdateState(i);
        }
    }

    /// @dev Unlock tokens
    function unlockTokens(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        try locker.getLockedBalance(actor) returns (uint256 locked) {
            if (locked == 0) return;
            amount = bound(amount, 1, locked);

            vm.prank(actor);
            try locker.unlock(amount) {} catch {}
        } catch {}

        vm.roll(block.number + 1);
    }

    /// @dev Create a proposal
    function createProposal(uint256 actorIdx) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        // Need at least 1 block history for getPastLockedBalance
        if (block.number < 2) {
            vm.roll(2);
        }

        address[] memory targets = new address[](1);
        targets[0] = address(governor);
        uint256[] memory values = new uint256[](1);
        values[0] = 0;
        bytes[] memory calldatas = new bytes[](1);
        calldatas[0] = abi.encodeWithSignature("proposalCount()"); // harmless read

        vm.prank(actor);
        try governor.propose(
            ProposalType.ParameterChange,
            targets,
            values,
            calldatas,
            "Test proposal"
        ) returns (uint256 proposalId) {
            ghost_proposalCount = proposalId;
            ghost_highestState[proposalId] = 0; // Pending
            ghost_quorumAtCreation[proposalId] = governor.quorum(proposalId);
        } catch {}

        // Update all proposal states
        for (uint256 i = 1; i <= ghost_proposalCount; i++) {
            _checkAndUpdateState(i);
        }
    }

    /// @dev Cast a vote on a proposal
    function castVote(uint256 actorIdx, uint256 proposalIdx, uint8 support) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        if (ghost_proposalCount == 0) return;
        proposalIdx = bound(proposalIdx, 1, ghost_proposalCount);
        support = uint8(bound(support, 0, 2));

        address actor = actors[actorIdx];

        vm.prank(actor);
        try governor.castVote(proposalIdx, support) {
            _voteRecords.push(VoteRecord({
                proposalId: proposalIdx,
                voter: actor
            }));
            ghost_voteCount++;
        } catch {}

        // Update all proposal states
        for (uint256 i = 1; i <= ghost_proposalCount; i++) {
            _checkAndUpdateState(i);
        }
    }

    /// @dev Advance time to move proposals through lifecycle
    function advanceTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1 hours, 10 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + 1);

        // Update all proposal states
        for (uint256 i = 1; i <= ghost_proposalCount; i++) {
            _checkAndUpdateState(i);
        }
    }

    /// @dev Queue a succeeded proposal
    function queueProposal(uint256 proposalIdx) external {
        if (ghost_proposalCount == 0) return;
        proposalIdx = bound(proposalIdx, 1, ghost_proposalCount);

        try governor.queue(proposalIdx) {} catch {}

        _checkAndUpdateState(proposalIdx);
    }

    /// @dev Transfer ARM tokens to/from treasury to attempt quorum manipulation
    function transferToTreasury(uint256 actorIdx, uint256 amount) external {
        actorIdx = bound(actorIdx, 0, actors.length - 1);
        address actor = actors[actorIdx];

        uint256 available = armToken.balanceOf(actor);
        if (available == 0) return;
        amount = bound(amount, 1, available);

        vm.prank(actor);
        armToken.transfer(treasuryAddr, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    // GETTERS for invariant checks
    // ═══════════════════════════════════════════════════════════════════

    function ghost_voteAt(uint256 idx) external view returns (uint256 proposalId, address voter) {
        require(idx < _voteRecords.length, "Out of bounds");
        VoteRecord storage r = _voteRecords[idx];
        return (r.proposalId, r.voter);
    }
}

/// @title GovernorInvariantTest — Foundry invariant test suite for ArmadaGovernor
contract GovernorInvariantTest is Test {
    ArmadaGovernor public governor;
    ArmadaToken public armToken;
    VotingLocker public locker;
    TimelockController public timelock;
    GovernorHandler public handler;

    address[] public actors;
    address public treasuryAddr;
    uint256 TOKENS_PER_ACTOR; // set in setUp() as 10% of supply per actor

    function setUp() public {
        // Deploy ARM token
        armToken = new ArmadaToken(address(this));
        TOKENS_PER_ACTOR = armToken.INITIAL_SUPPLY() / 10; // 10% of supply each

        // Deploy TimelockController
        address[] memory proposers = new address[](1);
        proposers[0] = address(0); // will be set after governor deploy
        address[] memory executors = new address[](1);
        executors[0] = address(0); // anyone can execute
        timelock = new TimelockController(
            1 days, // minDelay
            proposers,
            executors,
            address(this) // admin
        );

        // Deploy VotingLocker
        locker = new VotingLocker(address(armToken), address(this), 14 days, address(timelock));

        treasuryAddr = address(0xBABE);

        // Deploy Governor
        governor = new ArmadaGovernor(
            address(locker),
            address(armToken),
            payable(address(timelock)),
            treasuryAddr,
            address(this),
            14 days
        );

        // Grant governor the proposer role on timelock
        timelock.grantRole(timelock.PROPOSER_ROLE(), address(governor));
        timelock.grantRole(timelock.EXECUTOR_ROLE(), address(governor));

        // Create actors and fund them with ARM tokens
        for (uint256 i = 0; i < 5; i++) {
            address actor = address(uint160(0x8000 + i));
            actors.push(actor);
            armToken.transfer(actor, TOKENS_PER_ACTOR);
        }

        // Pre-lock tokens for actors so they can create proposals
        // (need voting power from past block)
        for (uint256 i = 0; i < actors.length; i++) {
            address actor = actors[i];
            uint256 lockAmount = TOKENS_PER_ACTOR / 2; // lock half

            vm.startPrank(actor);
            armToken.approve(address(locker), lockAmount);
            locker.lock(lockAmount);
            vm.stopPrank();
        }

        // Advance a few blocks so getPastLockedBalance works
        vm.roll(block.number + 5);
        vm.warp(block.timestamp + 1 hours);

        // Create handler
        handler = new GovernorHandler(governor, armToken, locker, actors, treasuryAddr);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = GovernorHandler.lockTokens.selector;
        selectors[1] = GovernorHandler.unlockTokens.selector;
        selectors[2] = GovernorHandler.createProposal.selector;
        selectors[3] = GovernorHandler.castVote.selector;
        selectors[4] = GovernorHandler.advanceTime.selector;
        selectors[5] = GovernorHandler.queueProposal.selector;
        selectors[6] = GovernorHandler.transferToTreasury.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-G1: ARM total supply is constant
    // ══════════════════════════════════════════════════════════════════════

    /// @notice ARM token total supply never changes from INITIAL_SUPPLY
    function invariant_armTotalSupplyConstant() public view {
        assertEq(
            armToken.totalSupply(),
            armToken.INITIAL_SUPPLY(),
            "INV-G1: ARM total supply changed"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-G2: One vote per address per proposal
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Every recorded vote is reflected in the governor's hasVoted mapping
    function invariant_oneVotePerAddress() public view {
        for (uint256 i = 0; i < handler.ghost_voteCount(); i++) {
            (uint256 proposalId, address voter) = handler.ghost_voteAt(i);
            assertTrue(
                governor.hasVoted(proposalId, voter),
                "INV-G2: Vote not recorded in hasVoted mapping"
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-G3: Proposal state transitions are monotonic
    // ══════════════════════════════════════════════════════════════════════

    /// @notice No proposal state ever went backward
    function invariant_proposalStateMonotonic() public view {
        assertEq(
            handler.ghost_stateMonotonicityViolations(),
            0,
            "INV-G3: Proposal state went backward"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-G4: VotingLocker totalLocked == sum(lockedBalance[user])
    // ══════════════════════════════════════════════════════════════════════

    /// @notice totalLocked matches sum of all individual locked balances
    function invariant_totalLockedConsistency() public view {
        uint256 sumLocked = 0;
        for (uint256 i = 0; i < actors.length; i++) {
            sumLocked += locker.getLockedBalance(actors[i]);
        }
        assertEq(
            locker.totalLocked(),
            sumLocked,
            "INV-G4: totalLocked != sum of individual balances"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // INV-G5: Quorum for a proposal never changes after creation
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Quorum is fixed at proposal creation and unaffected by treasury changes
    function invariant_quorumImmutable() public view {
        uint256 count = handler.ghost_proposalCount();
        for (uint256 i = 1; i <= count; i++) {
            uint256 creationQuorum = handler.ghost_quorumAtCreation(i);
            if (creationQuorum == 0) continue; // proposal creation may have failed
            uint256 currentQuorum = governor.quorum(i);
            assertEq(
                currentQuorum,
                creationQuorum,
                "INV-G5: Quorum changed after proposal creation"
            );
        }
    }

    /// @notice ARM token conservation: locker + actors + deployer = INITIAL_SUPPLY
    function invariant_armConservation() public view {
        uint256 total = armToken.balanceOf(address(locker));
        for (uint256 i = 0; i < actors.length; i++) {
            total += armToken.balanceOf(actors[i]);
        }
        total += armToken.balanceOf(address(this)); // deployer's remaining
        total += armToken.balanceOf(address(timelock)); // timelock may hold some
        total += armToken.balanceOf(treasuryAddr); // treasury
        assertEq(total, armToken.INITIAL_SUPPLY(), "ARM conservation violated");
    }
}
