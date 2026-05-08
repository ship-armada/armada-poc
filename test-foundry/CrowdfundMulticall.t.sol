// ABOUTME: Tests for OpenZeppelin Multicall integration on ArmadaCrowdfund.
// ABOUTME: Verifies bundled self-stack flow, atomicity, msg.sender preservation, and auth boundaries.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @notice Test suite for the Multicall mixin on ArmadaCrowdfund. Bundles all
///         13 inner calls of a hop-0 seed's full self-stack ($33K across hops
///         0/1/2) into a single transaction, then exercises the safety
///         properties documented in the implementation plan.
contract CrowdfundMulticallTest is Test {
    /// @dev Mirror of ArmadaCrowdfund.Invited so vm.expectEmit can match against it.
    event Invited(address indexed inviter, address indexed invitee, uint8 indexed hop, uint256 nonce);

    ArmadaCrowdfund internal crowdfund;
    MockUSDCV2 internal usdc;
    ArmadaToken internal armToken;
    address internal admin;
    address internal treasury;
    address internal launchTeam;
    address internal seed;
    address internal nonLaunchTeam;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant HOP0_COMMIT = 15_000 * 1e6;
    uint256 constant HOP1_COMMIT = 12_000 * 1e6;
    uint256 constant HOP2_COMMIT = 6_000 * 1e6;
    uint256 constant TOTAL_COMMIT = HOP0_COMMIT + HOP1_COMMIT + HOP2_COMMIT; // $33K

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);
        // Use a distinct launchTeam address so launchTeam != seed and we can
        // exercise the auth-boundary test without contaminating other tests.
        launchTeam = address(0xBEEF);
        seed = address(0xC0FFEE);
        nonLaunchTeam = address(0xBADD);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);
        crowdfund = new ArmadaCrowdfund(
            address(usdc),
            address(armToken),
            treasury,
            launchTeam,
            admin, // securityCouncil
            block.timestamp
        );

        address[] memory wl = new address[](2);
        wl[0] = admin;
        wl[1] = address(crowdfund);
        armToken.initWhitelist(wl);

        armToken.transfer(address(crowdfund), ARM_FUNDING);
        crowdfund.loadArm();

        // Add the seed under the launchTeam role.
        vm.prank(launchTeam);
        crowdfund.addSeed(seed);

        // Pre-fund the seed with the full $33K commit budget.
        usdc.mint(seed, TOTAL_COMMIT);
    }

    // ============ Calldata builders ============

    /// @dev Builds the full 12-call self-stack bundle in the mandatory order
    ///      (3× hop-1 invites, 6× hop-2 invites, then 3× commits).
    function _buildSelfStackCalls(address self_) internal pure returns (bytes[] memory calls) {
        calls = new bytes[](12);
        // hop-1 stacking (caller's hop-0 node invites caller at hop-1, 3×)
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, self_, uint8(0));
        calls[1] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, self_, uint8(0));
        calls[2] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, self_, uint8(0));
        // hop-2 stacking (caller's hop-1 node invites caller at hop-2, 6×)
        for (uint256 i = 0; i < 6; i++) {
            calls[3 + i] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, self_, uint8(1));
        }
        // Commits at each hop with the at-cap amounts.
        calls[9]  = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(0), HOP0_COMMIT);
        calls[10] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(1), HOP1_COMMIT);
        calls[11] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(2), HOP2_COMMIT);
    }

    // ============ Tests ============

    /// @dev WHY: Happy path — the headline UX win. A seed that approves once and
    ///      multicalls the 12-call bundle must end with hop-0/1/2 commitments at
    ///      $15K/$12K/$6K and invitesReceived = 1/3/6. This is the regression
    ///      sentinel for the entire bundling flow.
    function test_multicall_fullSelfStack_succeeds() public {
        bytes[] memory calls = _buildSelfStackCalls(seed);

        vm.startPrank(seed);
        usdc.approve(address(crowdfund), TOTAL_COMMIT);
        crowdfund.multicall(calls);
        vm.stopPrank();

        // hop-0: original seed slot.
        (, uint16 ir0,,, uint256 c0) = crowdfund.participants(seed, 0);
        assertEq(c0, HOP0_COMMIT, "hop-0 committed");
        assertEq(ir0, 1, "hop-0 invitesReceived");

        // hop-1: 3 self-invites → invitesReceived = 3, cap = 3 × $4K = $12K.
        (, uint16 ir1,,, uint256 c1) = crowdfund.participants(seed, 1);
        assertEq(c1, HOP1_COMMIT, "hop-1 committed");
        assertEq(ir1, 3, "hop-1 invitesReceived");

        // hop-2: 6 self-invites → invitesReceived = 6, cap = 6 × $1K = $6K.
        (, uint16 ir2,,, uint256 c2) = crowdfund.participants(seed, 2);
        assertEq(c2, HOP2_COMMIT, "hop-2 committed");
        assertEq(ir2, 6, "hop-2 invitesReceived");

        // USDC moved exactly $33K from seed to crowdfund.
        assertEq(usdc.balanceOf(seed), 0, "seed USDC drained");
        assertEq(usdc.balanceOf(address(crowdfund)), TOTAL_COMMIT, "contract holds $33K");
        assertEq(crowdfund.totalCommitted(), TOTAL_COMMIT, "totalCommitted matches");
    }

    /// @dev WHY: Atomicity — if any inner call reverts, the whole multicall must
    ///      revert with no state change. This protects the user from partial
    ///      whitelist/commit states that they'd then have to clean up manually.
    ///      We force the 4th call (the first hop-2 invite) to fail by replacing
    ///      it with an over-budget hop-0 invite (4th invite when budget is 3).
    function test_multicall_innerRevert_revertsAll() public {
        bytes[] memory calls = _buildSelfStackCalls(seed);
        // Replace call index 3 (first hop-2 invite) with an extra hop-0 invite.
        // Caller's hop-0 budget is 1 × maxInvites=3 = 3; the prior 3 calls
        // already consumed it, so this invite reverts with "invite limit reached".
        calls[3] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, seed, uint8(0));

        vm.startPrank(seed);
        usdc.approve(address(crowdfund), TOTAL_COMMIT);
        vm.expectRevert(bytes("ArmadaCrowdfund: invite limit reached"));
        crowdfund.multicall(calls);
        vm.stopPrank();

        // No state change — neither whitelist nor commits leaked through.
        (,,,, uint256 c0) = crowdfund.participants(seed, 0);
        (, uint16 ir1,,, uint256 c1) = crowdfund.participants(seed, 1);
        (, uint16 ir2,,, uint256 c2) = crowdfund.participants(seed, 2);
        assertEq(c0, 0, "no hop-0 commit on revert");
        assertEq(c1, 0, "no hop-1 commit on revert");
        assertEq(c2, 0, "no hop-2 commit on revert");
        assertEq(ir1, 0, "no hop-1 invites stuck");
        assertEq(ir2, 0, "no hop-2 invites stuck");
        assertEq(usdc.balanceOf(seed), TOTAL_COMMIT, "seed USDC untouched");
    }

    /// @dev WHY: msg.sender preservation through delegatecall is the safety
    ///      foundation of the OZ Multicall pattern. If it ever broke, the
    ///      Invited event would log the contract address instead of the seed,
    ///      and `participants[seed][1].invitedBy` would be wrong — corrupting
    ///      the invitation graph silently. Verify both event and storage.
    function test_multicall_msgSenderPreserved() public {
        bytes[] memory calls = _buildSelfStackCalls(seed);

        // The first hop-1 invite emits Invited(seed, seed, 1, 0). We assert
        // exactly that — proves _msgSender() under multicall == seed.
        vm.prank(seed);
        usdc.approve(address(crowdfund), TOTAL_COMMIT);
        vm.expectEmit(true, true, true, true, address(crowdfund));
        emit Invited(seed, seed, 1, 0);
        vm.prank(seed);
        crowdfund.multicall(calls);

        // invitedBy on the first hop-1 stacking call is the seed, not the contract.
        (address invitedBy1,,,,) = crowdfund.participants(seed, 1);
        assertEq(invitedBy1, seed, "hop-1 invitedBy must be seed");
        (address invitedBy2,,,,) = crowdfund.participants(seed, 2);
        assertEq(invitedBy2, seed, "hop-2 invitedBy must be seed");
    }

    /// @dev WHY: Multicall executes calldata array IN ORDER — the contract has
    ///      no semantic awareness of "stacking before commit". The frontend is
    ///      responsible for ordering; the contract must reject malformed
    ///      bundles loudly rather than silently misallocating. This documents
    ///      the constraint by deliberately committing-before-stacking.
    function test_multicall_badOrdering_revertsAtOffendingCall() public {
        // Build a bundle that commits at hop-1 BEFORE any hop-1 stacking.
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(1), HOP1_COMMIT);
        calls[1] = abi.encodeWithSelector(ArmadaCrowdfund.invite.selector, seed, uint8(0));

        vm.startPrank(seed);
        usdc.approve(address(crowdfund), HOP1_COMMIT);
        // commit(1, ...) requires participants[seed][1].isWhitelisted, which is false.
        vm.expectRevert(bytes("ArmadaCrowdfund: not whitelisted"));
        crowdfund.multicall(calls);
        vm.stopPrank();
    }

    /// @dev WHY: The OZ Multicall delegate-calls each item sequentially, so the
    ///      nonReentrant guard acquired by call N must be released before call
    ///      N+1 acquires it. Bundling two commits proves the lock truly
    ///      releases between calls (otherwise the second would revert with
    ///      "ReentrancyGuard: reentrant call"). This is the test that catches
    ///      a hypothetical Multicall variant that nests instead of sequences.
    function test_multicall_nonReentrantReleasesBetweenCalls() public {
        // Stack hop-1 first via single calls so the multicall can be just two commits.
        vm.startPrank(seed);
        crowdfund.invite(seed, 0); // hop-0 → hop-1, invitesReceived=1
        usdc.approve(address(crowdfund), HOP0_COMMIT + 4_000 * 1e6);
        vm.stopPrank();

        // Bundle two commits at different hops — both must succeed.
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(0), HOP0_COMMIT);
        calls[1] = abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(1), 4_000 * 1e6);

        vm.prank(seed);
        crowdfund.multicall(calls);

        (,,,, uint256 c0) = crowdfund.participants(seed, 0);
        (,,,, uint256 c1) = crowdfund.participants(seed, 1);
        assertEq(c0, HOP0_COMMIT, "hop-0 commit landed");
        assertEq(c1, 4_000 * 1e6, "hop-1 commit landed (lock released between calls)");
    }

    /// @dev WHY: Gas snapshot. The full self-stack bundle should land in the
    ///      ~700K–900K range under cold storage. Asserting < 1.5M leaves slack
    ///      for compiler/optimizer drift while still catching a regression
    ///      that doubles the cost (e.g., accidentally re-introducing a per-
    ///      call overhead). Logged value for inspection in -vv runs.
    function test_multicall_gasSnapshot() public {
        bytes[] memory calls = _buildSelfStackCalls(seed);

        vm.prank(seed);
        usdc.approve(address(crowdfund), TOTAL_COMMIT);

        vm.prank(seed);
        uint256 g = gasleft();
        crowdfund.multicall(calls);
        uint256 used = g - gasleft();
        emit log_named_uint("self_stack_multicall_gas", used);

        assertLt(used, 1_500_000, "self-stack bundle gas under 1.5M");
    }

    /// @dev WHY: Critical safety property. Multicall must NOT bypass per-
    ///      function auth modifiers. A non-launch-team caller invoking
    ///      addSeed via multicall must still revert on `onlyLaunchTeam`,
    ///      proving msg.sender propagation works correctly in the auth path.
    ///      If this ever passed, an attacker could trivially seize launch-
    ///      team privileges by wrapping the call in multicall.
    function test_multicall_doesNotBypassOnlyLaunchTeam() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSelector(
            ArmadaCrowdfund.addSeed.selector,
            address(0xDEAD)
        );

        vm.prank(nonLaunchTeam);
        vm.expectRevert(bytes("ArmadaCrowdfund: not launch team"));
        crowdfund.multicall(calls);
    }
}
