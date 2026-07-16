// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for RedemptionRouter — contingency periphery wrapping ArmadaRedemption.redeem
// ABOUTME: with a deploy-time-baked token list. Covers redeemAll payouts, fairness parity, and validation.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/periphery/RedemptionRouter.sol";
import "../contracts/governance/ArmadaRedemption.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockTokenRouter is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal mock of ArmadaWindDown exposing the `triggerTime()` getter that
///      ArmadaRedemption reads. Lets tests simulate trigger state without deploying
///      the full wind-down contract and its dependency graph.
contract MockWindDownRouter {
    uint256 public triggerTime;
    function setTriggerTime(uint256 _t) external { triggerTime = _t; }
}

/// @dev Mock of RevenueLock exposing only the `lockedAtWindDown()` view that
///      ArmadaRedemption reads.
contract MockRevenueLockRouter {
    uint256 public lockedAtWindDown;
    function setLocked(uint256 v) external { lockedAtWindDown = v; }
}

/// @dev Mock of ArmadaCrowdfund exposing only the `armStillOwed()` view that
///      ArmadaRedemption reads.
contract MockCrowdfundRouter {
    uint256 public armStillOwed;
    function setStillOwed(uint256 v) external { armStillOwed = v; }
}

contract RedemptionRouterTest is Test {
    // Mirror events
    event RouterRedeemed(address indexed caller, address indexed recipient, uint256 armAmount);

    ArmadaRedemption public redemption;
    RedemptionRouter public router;
    ArmadaToken public armToken;
    TimelockController public timelock;
    MockTokenRouter public usdc;
    MockTokenRouter public weth;
    MockWindDownRouter public windDown;
    MockRevenueLockRouter public revenueLockMock;
    MockCrowdfundRouter public crowdfundMock;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public treasuryAddr = address(0x7777);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;

    /// @dev Sorted-ascending [usdc, weth] pair for router construction — the
    ///      core contract requires ascending order, and the router bakes the
    ///      list at deploy time.
    function _sortedPair(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        (out[0], out[1]) = a < b ? (a, b) : (b, a);
    }

    function setUp() public {
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));
        windDown = new MockWindDownRouter();
        revenueLockMock = new MockRevenueLockRouter();
        crowdfundMock = new MockCrowdfundRouter();

        // Enable transfers (simulating wind-down having triggered)
        armToken.setWindDownContract(address(windDown));
        vm.prank(address(windDown));
        armToken.setTransferable(true);

        redemption = new ArmadaRedemption(
            address(armToken),
            treasuryAddr,
            address(revenueLockMock),
            address(crowdfundMock)
        );

        // Wire wind-down, simulate trigger, warp past REDEMPTION_DELAY.
        redemption.setWindDown(address(windDown));
        windDown.setTriggerTime(block.timestamp);
        vm.warp(block.timestamp + 7 days + 1);

        // Distribute ARM: treasury 65%, revenueLock 15%, crowdfund 10%, alice 5%, bob 5%.
        armToken.transfer(treasuryAddr, TOTAL_SUPPLY * 65 / 100);
        armToken.transfer(address(revenueLockMock), TOTAL_SUPPLY * 15 / 100);
        armToken.transfer(address(crowdfundMock), TOTAL_SUPPLY * 10 / 100);
        armToken.transfer(alice, TOTAL_SUPPLY * 5 / 100);
        armToken.transfer(bob, TOTAL_SUPPLY * 5 / 100);

        // Fully-locked revenueLock, zero-owed crowdfund → circulating = alice + bob = 1.2M.
        revenueLockMock.setLocked(armToken.balanceOf(address(revenueLockMock)));
        crowdfundMock.setStillOwed(0);

        // Fund redemption, simulating completed sweeps: $500k USDC, 100 WETH, 10 ETH.
        usdc = new MockTokenRouter("Mock USDC", "USDC");
        weth = new MockTokenRouter("Wrapped ETH", "WETH");
        usdc.mint(address(redemption), 500_000e6);
        weth.mint(address(redemption), 100e18);
        vm.deal(address(redemption), 10 ether);

        // Deploy the router with the full swept list, as the runbook prescribes
        // during the post-trigger window.
        router = new RedemptionRouter(
            address(armToken),
            address(redemption),
            _sortedPair(address(usdc), address(weth))
        );

        // Redeemers approve the ROUTER (not the redemption contract) for ARM.
        vm.prank(alice);
        armToken.approve(address(router), type(uint256).max);
        vm.prank(bob);
        armToken.approve(address(router), type(uint256).max);
    }

    // ======== redeemAll Happy Path ========

    // WHY: The router's entire reason to exist (issue #256) — one call claims the
    // caller's pro-rata share of EVERY swept asset, so a direct caller cannot
    // forget a token and silently forfeit it. Alice holds 600k of 1.2M
    // circulating = 50% of each asset.
    function test_redeemAll_paysAllAssetsInOneCall() public {
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.prank(alice);
        router.redeemAll(aliceArm, alice);

        assertEq(usdc.balanceOf(alice), 250_000e6, "50% of USDC");
        assertEq(weth.balanceOf(alice), 50e18, "50% of WETH");
        assertEq(alice.balance, 5 ether, "50% of ETH");
        // ARM locked in the redemption contract, not the router.
        assertEq(armToken.balanceOf(address(redemption)), aliceArm);
        assertEq(armToken.balanceOf(alice), 0);
    }

    // WHY: The router is a pass-through, never a vault. Any balance left behind
    // after redeemAll would be forfeited to the next caller — assert every asset
    // (ARM, both ERC20s, ETH) fully leaves the router within the call.
    function test_redeemAll_leavesNoResidueInRouter() public {
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.prank(alice);
        router.redeemAll(aliceArm, alice);

        assertEq(armToken.balanceOf(address(router)), 0, "no ARM residue");
        assertEq(usdc.balanceOf(address(router)), 0, "no USDC residue");
        assertEq(weth.balanceOf(address(router)), 0, "no WETH residue");
        assertEq(address(router).balance, 0, "no ETH residue");
    }

    // WHY: Sequential correctness must be preserved through the router — a
    // router redemption and a direct redemption interleaved must produce the
    // same pro-rata outcomes as two direct redemptions (the router must not
    // perturb the denominator or asset balances beyond what redeem() does).
    function test_redeemAll_fairnessParityWithDirectRedeem() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 bobArm = armToken.balanceOf(bob);

        // Alice goes through the router.
        vm.prank(alice);
        router.redeemAll(aliceArm, alice);

        // Bob redeems directly against the core contract with the full list.
        vm.prank(bob);
        armToken.approve(address(redemption), type(uint256).max);
        vm.prank(bob);
        redemption.redeem(bobArm, _sortedPair(address(usdc), address(weth)), bob);

        // Equal holders → equal outcomes regardless of path.
        assertEq(usdc.balanceOf(alice), usdc.balanceOf(bob), "USDC parity");
        assertEq(weth.balanceOf(alice), weth.balanceOf(bob), "WETH parity");
        assertEq(alice.balance, bob.balance, "ETH parity");
    }

    // WHY: A USDC-only protocol may wind down with zero ETH swept. The core
    // contract ignores ethRecipient when the pool holds no ETH; the router must
    // pass that case through rather than reverting.
    function test_redeemAll_emptyEthPool() public {
        vm.deal(address(redemption), 0);
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.prank(alice);
        router.redeemAll(aliceArm, alice);

        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(weth.balanceOf(alice), 50e18);
        assertEq(alice.balance, 0);
    }

    // WHY: Smart-wallet/multisig callers that cannot receive ETH need to route
    // the entire payout to an address they control. The recipient parameter
    // must carry ALL assets — ERC20s and ETH — not just the ETH share.
    function test_redeemAll_routesAllAssetsToThirdPartyRecipient() public {
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.prank(alice);
        router.redeemAll(aliceArm, bob);

        assertEq(usdc.balanceOf(bob), 250_000e6, "USDC to recipient");
        assertEq(weth.balanceOf(bob), 50e18, "WETH to recipient");
        assertEq(bob.balance, 5 ether, "ETH to recipient");
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(alice.balance, 0);
    }

    // WHY: The watchdog described in the wind-down runbook keys off this event
    // to compare router redemptions against expected payouts.
    function test_redeemAll_emitsEvent() public {
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.expectEmit(true, true, false, true);
        emit RouterRedeemed(alice, alice, aliceArm);
        vm.prank(alice);
        router.redeemAll(aliceArm, alice);
    }

    // WHY: Tokens donated (or mistakenly sent) to the router are forwarded to
    // the next redeemer rather than retained — documents that the router holds
    // nothing across calls, so there is no balance an attacker can rely on.
    function test_redeemAll_forwardsDonatedTokens() public {
        usdc.mint(address(router), 1_000e6); // stray donation
        uint256 aliceArm = armToken.balanceOf(alice);

        vm.prank(alice);
        router.redeemAll(aliceArm, alice);

        // Alice receives her share plus the stray donation.
        assertEq(usdc.balanceOf(alice), 250_000e6 + 1_000e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ======== redeemAll Guards ========

    // WHY: A zero recipient would send ERC20 payouts to address(0) (reverting
    // deep inside SafeERC20) or silently drop the ETH share when the core
    // contract ignores ethRecipient on an empty pool. Fail loud at the door.
    function test_revert_redeemAll_zeroRecipient() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert("RedemptionRouter: zero recipient");
        router.redeemAll(aliceArm, address(0));
    }

    // WHY: Core-contract guards must propagate through the router unchanged —
    // the router adds a safety layer, it must not swallow or reshape failures.
    function test_revert_redeemAll_zeroAmountPropagates() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero amount");
        router.redeemAll(0, alice);
    }

    // WHY: A dust-sized ARM amount rounds every share to zero; the core
    // contract reverts rather than locking ARM for nothing. Verify the router
    // inherits this loud failure and the caller keeps their ARM.
    function test_revert_redeemAll_dustAmountKeepsArm() public {
        uint256 aliceArmBefore = armToken.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for token");
        router.redeemAll(1, alice);

        assertEq(armToken.balanceOf(alice), aliceArmBefore, "ARM rolled back");
    }

    // ======== Constructor Validation ========
    // WHY (all): the router's value is that its token list is correct by
    // construction — a malformed list must fail at DEPLOY time, during the
    // coordinated runbook window, never at user redemption time.

    function test_constructor_rejectsZeroArmToken() public {
        vm.expectRevert("RedemptionRouter: zero armToken");
        new RedemptionRouter(address(0), address(redemption), _sortedPair(address(usdc), address(weth)));
    }

    function test_constructor_rejectsZeroRedemption() public {
        vm.expectRevert("RedemptionRouter: zero redemption");
        new RedemptionRouter(address(armToken), address(0), _sortedPair(address(usdc), address(weth)));
    }

    function test_constructor_rejectsZeroTokenEntry() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        vm.expectRevert("RedemptionRouter: zero token");
        new RedemptionRouter(address(armToken), address(redemption), tokens);
    }

    function test_constructor_rejectsArmInList() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(armToken);
        vm.expectRevert("RedemptionRouter: ARM in token list");
        new RedemptionRouter(address(armToken), address(redemption), tokens);
    }

    function test_constructor_rejectsUnsortedList() public {
        address[] memory sorted = _sortedPair(address(usdc), address(weth));
        address[] memory unsorted = new address[](2);
        (unsorted[0], unsorted[1]) = (sorted[1], sorted[0]);
        vm.expectRevert("RedemptionRouter: tokens not sorted/unique");
        new RedemptionRouter(address(armToken), address(redemption), unsorted);
    }

    function test_constructor_rejectsDuplicateList() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(usdc);
        vm.expectRevert("RedemptionRouter: tokens not sorted/unique");
        new RedemptionRouter(address(armToken), address(redemption), tokens);
    }

    // ======== ETH-Only Wind-Down ========

    // WHY: An empty token list is legal — a wind-down where only ETH was swept
    // (no ERC20 assets) must still be routable. The core contract's anyPayout
    // guard is satisfied by the ETH payout alone.
    function test_redeemAll_ethOnlyEmptyTokenList() public {
        RedemptionRouter ethRouter = new RedemptionRouter(
            address(armToken), address(redemption), new address[](0)
        );
        vm.prank(alice);
        armToken.approve(address(ethRouter), type(uint256).max);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        ethRouter.redeemAll(aliceArm, alice);

        assertEq(alice.balance, 5 ether, "50% of ETH");
        assertEq(usdc.balanceOf(alice), 0, "no ERC20 claimed");
    }

    // ======== View ========

    // WHY: Users and the runbook verification step must be able to read the
    // baked list in one call before approving ARM to the router (anti-phishing:
    // the published manifest is checked against this getter).
    function test_allTokens_returnsBakedList() public view {
        address[] memory expected = _sortedPair(address(usdc), address(weth));
        address[] memory actual = router.allTokens();
        assertEq(actual.length, 2);
        assertEq(actual[0], expected[0]);
        assertEq(actual[1], expected[1]);
    }
}
