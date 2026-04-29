// SPDX-License-Identifier: MIT
// ABOUTME: Foundry tests for ArmadaRedemption — pro-rata treasury redemption for ARM holders.
// ABOUTME: Covers single/sequential redemption, ETH redemption, denominator math, guards, and edge cases.
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/governance/ArmadaRedemption.sol";
import "../contracts/governance/ArmadaToken.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for testing
contract MockTokenRedemption is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal mock of ArmadaWindDown exposing the `triggerTime()` getter that
///      ArmadaRedemption reads. Lets tests simulate trigger state without deploying
///      the full wind-down contract and its dependency graph.
contract MockWindDownRedemption {
    uint256 public triggerTime;
    function setTriggerTime(uint256 _t) external { triggerTime = _t; }
}

contract ArmadaRedemptionTest is Test {
    // Mirror events
    event Redeemed(address indexed redeemer, uint256 armAmount, address[] tokens, uint256 ethAmount);
    event WindDownSet(address indexed windDown);

    ArmadaRedemption public redemption;
    ArmadaToken public armToken;
    TimelockController public timelock;
    MockTokenRedemption public usdc;
    MockTokenRedemption public weth;
    MockWindDownRedemption public windDown;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);
    address public treasuryAddr = address(0x7777);
    address public revenueLock = address(0xABCD);
    address public crowdfund = address(0xCF00);

    uint256 constant TOTAL_SUPPLY = 12_000_000 * 1e18;
    uint256 constant TWO_DAYS = 2 days;

    function setUp() public {
        // Deploy governance token
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        timelock = new TimelockController(TWO_DAYS, proposers, executors, deployer);

        armToken = new ArmadaToken(deployer, address(timelock));

        // Deploy a mock wind-down contract. Tests use this to simulate the triggerTime
        // that ArmadaRedemption reads via the IArmadaWindDownRedemption interface.
        windDown = new MockWindDownRedemption();

        // Enable transfers (simulating wind-down having triggered)
        armToken.setWindDownContract(address(windDown));
        vm.prank(address(windDown));
        armToken.setTransferable(true);

        // Whitelist deployer, alice, bob, and the redemption contract address
        // (We need to deploy redemption first to know its address, or whitelist after)
        // Since transfers are enabled, whitelist doesn't matter anymore

        // Deploy redemption
        redemption = new ArmadaRedemption(
            address(armToken),
            treasuryAddr,
            revenueLock,
            crowdfund
        );

        // Wire wind-down reference on redemption (one-time setter) and simulate that
        // wind-down triggered at the current timestamp. Warp past REDEMPTION_DELAY so
        // the happy-path tests can call redeem() without coordinating the delay.
        redemption.setWindDown(address(windDown));
        windDown.setTriggerTime(block.timestamp);
        vm.warp(block.timestamp + 7 days + 1);

        // Distribute ARM
        // Treasury gets 65%, revenue-lock gets 15%, crowdfund gets 10%, alice 5%, bob 5%
        armToken.transfer(treasuryAddr, TOTAL_SUPPLY * 65 / 100);  // 7.8M
        armToken.transfer(revenueLock, TOTAL_SUPPLY * 15 / 100);   // 1.8M
        armToken.transfer(crowdfund, TOTAL_SUPPLY * 10 / 100);      // 1.2M
        armToken.transfer(alice, TOTAL_SUPPLY * 5 / 100);           // 600K
        armToken.transfer(bob, TOTAL_SUPPLY * 5 / 100);             // 600K

        // Deploy mock tokens and fund redemption (simulating post-sweep)
        usdc = new MockTokenRedemption("Mock USDC", "USDC");
        weth = new MockTokenRedemption("Wrapped ETH", "WETH");

        usdc.mint(address(redemption), 500_000e6);  // $500k USDC in redemption
        weth.mint(address(redemption), 100e18);       // 100 WETH in redemption

        // Approve redemption to take ARM from alice and bob
        vm.prank(alice);
        armToken.approve(address(redemption), type(uint256).max);
        vm.prank(bob);
        armToken.approve(address(redemption), type(uint256).max);
    }

    // ======== Basic Redemption ========

    function test_redeem_proRataUSDC() public {
        // Circulating supply = total - treasury - revenueLock - crowdfund - redemption(0)
        // = 12M - 7.8M - 1.8M - 1.2M - 0 = 1.2M ARM circulating
        uint256 circulating = redemption.circulatingSupply();
        assertEq(circulating, TOTAL_SUPPLY * 10 / 100); // 1.2M = 10%

        uint256 aliceArm = armToken.balanceOf(alice); // 600K
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);

        // Alice has 600K out of 1.2M circulating = 50% → $250k USDC
        assertEq(usdc.balanceOf(alice), 250_000e6);
    }

    function test_redeem_multipleTokens() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](2);
        // Must be sorted ascending
        if (address(usdc) < address(weth)) {
            tokens[0] = address(usdc);
            tokens[1] = address(weth);
        } else {
            tokens[0] = address(weth);
            tokens[1] = address(usdc);
        }

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);

        // 50% of each
        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(weth.balanceOf(alice), 50e18);
    }

    function test_redeem_armLockedPermanently() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);

        // ARM is in the redemption contract
        assertEq(armToken.balanceOf(address(redemption)), aliceArm);
        // Alice has no ARM
        assertEq(armToken.balanceOf(alice), 0);
    }

    // ======== Sequential Correctness ========

    function test_sequential_correctness() public {
        uint256 aliceArm = armToken.balanceOf(alice); // 600K
        uint256 bobArm = armToken.balanceOf(bob);     // 600K

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Alice redeems first (600K out of 1.2M = 50%)
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);
        assertEq(usdc.balanceOf(alice), 250_000e6); // 50% of $500k

        // After Alice's redemption:
        // - Redemption contract has 600K ARM
        // - Circulating = 12M - 7.8M - 1.8M - 1.2M - 600K = 600K
        // - USDC remaining = 250k
        // Bob redeems (600K out of 600K = 100%)
        vm.prank(bob);
        redemption.redeem(bobArm, tokens, false);
        assertEq(usdc.balanceOf(bob), 250_000e6); // 100% of remaining $250k

        // Both got equal shares: $250k each
    }

    function test_partial_redemption() public {
        uint256 halfArm = armToken.balanceOf(alice) / 2; // 300K

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Alice redeems half her ARM (300K out of 1.2M = 25%)
        vm.prank(alice);
        redemption.redeem(halfArm, tokens, false);
        assertEq(usdc.balanceOf(alice), 125_000e6); // 25% of $500k

        // Alice redeems other half (300K out of 900K remaining circulating)
        // 300K / 900K = 33.3% of remaining $375k = $125k
        vm.prank(alice);
        redemption.redeem(halfArm, tokens, false);
        assertEq(usdc.balanceOf(alice), 250_000e6); // Total still $250k
    }

    // ======== ETH Redemption ========

    function test_redeemETH() public {
        // Fund redemption with ETH
        vm.deal(address(redemption), 10 ether);

        uint256 aliceArm = armToken.balanceOf(alice); // 600K out of 1.2M = 50%
        address[] memory tokens = new address[](0);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, true);

        assertEq(alice.balance, 5 ether); // 50% of 10 ETH
    }

    function test_redeem_ERC20AndETHTogether() public {
        // Fund redemption with ETH
        vm.deal(address(redemption), 10 ether);

        uint256 aliceArm = armToken.balanceOf(alice); // 600K out of 1.2M = 50%
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, true);

        // Gets 50% of both in one deposit
        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(alice.balance, 5 ether);
    }

    function test_sequential_ERC20AndETH() public {
        // Fund redemption with ETH
        vm.deal(address(redemption), 10 ether);

        uint256 aliceArm = armToken.balanceOf(alice); // 600K
        uint256 bobArm = armToken.balanceOf(bob);     // 600K

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Alice redeems all assets in one call
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, true);
        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(alice.balance, 5 ether);

        // Bob redeems — gets 100% of remaining
        vm.prank(bob);
        redemption.redeem(bobArm, tokens, true);
        assertEq(usdc.balanceOf(bob), 250_000e6);
        assertEq(bob.balance, 5 ether);
    }

    // ======== ARM Token Guard ========

    function test_revert_cannotRedeemARM() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(armToken);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: cannot redeem ARM");
        redemption.redeem(aliceArm, tokens, false);
    }

    function test_revert_cannotRedeemARMInMultiTokenList() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](2);
        // Put ARM as second token (after a valid token)
        if (address(usdc) < address(armToken)) {
            tokens[0] = address(usdc);
            tokens[1] = address(armToken);
        } else {
            tokens[0] = address(armToken);
            tokens[1] = address(usdc);
        }

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: cannot redeem ARM");
        redemption.redeem(aliceArm, tokens, false);
    }

    // ======== Duplicate Token Guard ========

    function test_revert_duplicateTokens() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(usdc);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: tokens not sorted/unique");
        redemption.redeem(aliceArm, tokens, false);
    }

    function test_revert_unsortedTokens() public {
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](2);
        // Put higher address first
        if (address(usdc) > address(weth)) {
            tokens[0] = address(usdc);
            tokens[1] = address(weth);
        } else {
            tokens[0] = address(weth);
            tokens[1] = address(usdc);
        }

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: tokens not sorted/unique");
        redemption.redeem(aliceArm, tokens, false);
    }

    // ======== Circulating Supply ========

    function test_circulatingSupply_excludesCorrectAddresses() public {
        uint256 circulating = redemption.circulatingSupply();
        uint256 total = armToken.totalSupply();
        uint256 excluded = armToken.balanceOf(treasuryAddr) +
                          armToken.balanceOf(revenueLock) +
                          armToken.balanceOf(crowdfund) +
                          armToken.balanceOf(address(redemption));

        assertEq(circulating, total - excluded);
    }

    function test_circulatingSupply_shrinksAfterRedemption() public {
        uint256 circulatingBefore = redemption.circulatingSupply();

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);

        uint256 circulatingAfter = redemption.circulatingSupply();
        assertTrue(circulatingAfter < circulatingBefore);
        assertEq(circulatingAfter, circulatingBefore - aliceArm);
    }

    // ======== Edge Cases ========

    function test_revert_zeroArmAmount() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero amount");
        redemption.redeem(0, tokens, false);
    }

    function test_revert_zeroArmAmount_eth() public {
        address[] memory tokens = new address[](0);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero amount");
        redemption.redeem(0, tokens, true);
    }

    function test_revert_redeem_emptyTokenListNoETH() public {
        // WHY: Prevents ARM lock-in with zero payout. An empty tokens list with
        // includeETH=false produces no payout; the empty-input guard reverts so
        // safeTransferFrom is rolled back and ARM stays in the caller's wallet.
        address[] memory tokens = new address[](0);
        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 aliceArmBefore = armToken.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: must request at least one asset");
        redemption.redeem(aliceArm, tokens, false);

        // ARM is NOT locked — the revert rolled back safeTransferFrom
        assertEq(armToken.balanceOf(alice), aliceArmBefore);
        assertEq(armToken.balanceOf(address(redemption)), 0);
    }

    // WHY: A zero-address entry in the tokens[] list would otherwise revert
    // indirectly via the IERC20.balanceOf call hitting the EXTCODESIZE check on
    // address(0). The explicit guard inside the loop matches the explicit
    // tokens[i] != armToken check above it and produces a clean error message.
    function test_revert_redeem_zeroToken() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero token");
        redemption.redeem(aliceArm, tokens, false);
    }

    function test_revert_redeem_tokenWithZeroBalance() public {
        // WHY: A user listing a token whose sweep has not yet run would otherwise
        // lock ARM for zero payout on that token (partial-sweep forfeiture case).
        // The strict per-asset share check now reverts before ARM is committed.
        MockTokenRedemption emptyToken = new MockTokenRedemption("Empty", "EMPTY");
        address[] memory tokens = new address[](1);
        tokens[0] = address(emptyToken);

        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 aliceArmBefore = armToken.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for token");
        redemption.redeem(aliceArm, tokens, false);

        assertEq(emptyToken.balanceOf(alice), 0);
        assertEq(armToken.balanceOf(alice), aliceArmBefore);
    }

    // WHY: Sequential-correctness violation per GOVERNANCE.md §Redemption mechanism.
    // If sweepers run in stages — say USDC swept but OTHER not yet — a redeemer who
    // requests both used to receive USDC, get anyPayout=true, and silently forfeit
    // their share of OTHER. Their ARM stayed locked, reducing `circulating` for
    // everyone after, so late redeemers absorbed the forfeited shares. The strict
    // require fires at the un-swept asset, reverts the redemption entirely, and
    // forces the redeemer to wait or to call again with only swept assets.
    function test_revert_redeem_partialSweep_unsweptTokenForfeited() public {
        // Deploy two redeemable tokens. Sweep only one of them.
        MockTokenRedemption other = new MockTokenRedemption("Other", "OTH");
        usdc.mint(address(redemption), 1_000_000e6); // simulating USDC sweep landed
        // `other` has zero balance — sweep has not run yet.

        address[] memory tokens = new address[](2);
        // Sort ascending so the existing tokens-not-sorted check passes.
        if (address(usdc) < address(other)) {
            tokens[0] = address(usdc);
            tokens[1] = address(other);
        } else {
            tokens[0] = address(other);
            tokens[1] = address(usdc);
        }

        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 aliceArmBefore = aliceArm;

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for token");
        redemption.redeem(aliceArm, tokens, false);

        // ARM rolled back; Alice received nothing.
        assertEq(armToken.balanceOf(alice), aliceArmBefore);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(other.balanceOf(alice), 0);
    }

    // WHY: ETH path mirrors the per-token rule. A redeemer with includeETH=true but
    // no ETH yet swept used to get tokens, mark anyPayout, and silently forfeit
    // their ETH share. Same sequential-correctness violation as the token case.
    function test_revert_redeem_includeETH_butNoETHSwept() public {
        // ERC20 sweep landed; ETH sweep has not run.
        usdc.mint(address(redemption), 1_000_000e6);
        // address(redemption).balance is 0 (no ETH swept).

        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 aliceArmBefore = aliceArm;

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for ETH");
        redemption.redeem(aliceArm, tokens, true);

        // ARM rolled back; Alice received nothing.
        assertEq(armToken.balanceOf(alice), aliceArmBefore);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(alice.balance, 0);
    }

    function test_redeem_ethOnlyNoERC20() public {
        vm.deal(address(redemption), 10 ether);
        address[] memory tokens = new address[](0);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, true);

        assertEq(alice.balance, 5 ether);
        // No USDC should have been touched
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_redeem_includeETHFalse_noETHSent() public {
        vm.deal(address(redemption), 10 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);

        // Got USDC but no ETH
        assertEq(usdc.balanceOf(alice), 250_000e6);
        assertEq(alice.balance, 0);
        // ETH still in contract
        assertEq(address(redemption).balance, 10 ether);
    }

    function test_redemptionCanReceiveETH() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(redemption).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(redemption).balance, 1 ether);
    }

    // ======== Wind-Down Gate ========

    function test_revert_redeemBeforeWindDown() public {
        // Deploy a fresh ARM token where transferable is still false (pre-wind-down)
        ArmadaToken freshArm = new ArmadaToken(deployer, address(timelock));
        freshArm.setWindDownContract(address(windDown));

        // Whitelist deployer and alice so we can distribute tokens without enabling global transfers
        address[] memory wl = new address[](2);
        wl[0] = deployer;
        wl[1] = alice;
        freshArm.initWhitelist(wl);

        ArmadaRedemption freshRedemption = new ArmadaRedemption(
            address(freshArm), treasuryAddr, revenueLock, crowdfund
        );

        freshArm.transfer(alice, 1000e18);
        vm.prank(alice);
        freshArm.approve(address(freshRedemption), type(uint256).max);

        // transferable is still false — redeem should revert
        address[] memory tokens = new address[](0);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: wind-down not triggered");
        freshRedemption.redeem(1000e18, tokens, false);
    }

    // ======== setWindDown Guard ========

    function test_setWindDown_emitsEvent() public {
        // WHY: Redeployed setter path exercised in an isolated redemption to confirm
        // the WindDownSet event fires exactly once with the provided address.
        ArmadaRedemption fresh = new ArmadaRedemption(
            address(armToken), treasuryAddr, revenueLock, crowdfund
        );
        MockWindDownRedemption freshWD = new MockWindDownRedemption();
        vm.expectEmit(true, false, false, false);
        emit WindDownSet(address(freshWD));
        fresh.setWindDown(address(freshWD));
        assertEq(fresh.windDown(), address(freshWD));
    }

    function test_revert_setWindDownTwice() public {
        // WHY: windDown must be immutable after first-set to prevent later rebinding
        // (which would let an admin redirect the triggerTime source).
        MockWindDownRedemption other = new MockWindDownRedemption();
        vm.expectRevert("ArmadaRedemption: wind-down already set");
        redemption.setWindDown(address(other));
    }

    function test_revert_setWindDownNotAdmin() public {
        // WHY: Only the deployer may wire the wind-down reference. Anyone else calling
        // would be either a mistake or an attack to point the delay check at a lying
        // contract.
        ArmadaRedemption fresh = new ArmadaRedemption(
            address(armToken), treasuryAddr, revenueLock, crowdfund
        );
        MockWindDownRedemption freshWD = new MockWindDownRedemption();
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: not admin");
        fresh.setWindDown(address(freshWD));
    }

    function test_revert_setWindDownZero() public {
        // WHY: Zero address would make redeem() permanently revert on the wind-down
        // interface call. Reject at set time for a clearer failure.
        ArmadaRedemption fresh = new ArmadaRedemption(
            address(armToken), treasuryAddr, revenueLock, crowdfund
        );
        vm.expectRevert("ArmadaRedemption: zero windDown");
        fresh.setWindDown(address(0));
    }

    // ======== Redemption Delay (issue #254 social-coordination mitigation) ========

    function test_revert_redeemBeforeDelayElapsed() public {
        // WHY: Users must not redeem during the coordination window. This prevents a
        // same-block race between the wind-down trigger and the first redemption,
        // giving sweep operators time to act. Reset triggerTime to now to re-enter
        // the pre-delay window (setUp warped us past it for happy-path tests).
        windDown.setTriggerTime(block.timestamp);
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        // Try at triggerTime + delay - 1 — still in the gate window
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: redemption delay not elapsed");
        redemption.redeem(aliceArm, tokens, false);
    }

    function test_redeemAtDelayBoundary() public {
        // WHY: block.timestamp == triggerTime + REDEMPTION_DELAY is the earliest
        // allowed moment (require uses `>=`). Verify this boundary is inclusive.
        windDown.setTriggerTime(block.timestamp);
        uint256 aliceArm = armToken.balanceOf(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);

        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        redemption.redeem(aliceArm, tokens, false);
        assertEq(usdc.balanceOf(alice), 250_000e6);
    }

    function test_revert_redeemIfWindDownNotSet() public {
        // WHY: Pre-setWindDown, redeem must hard-fail. Without this check, a
        // mis-ordered deploy would silently skip the delay gate.
        ArmadaRedemption fresh = new ArmadaRedemption(
            address(armToken), treasuryAddr, revenueLock, crowdfund
        );
        vm.prank(alice);
        armToken.approve(address(fresh), type(uint256).max);
        address[] memory tokens = new address[](0);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: wind-down not set");
        fresh.redeem(100e18, tokens, true);
    }

    function test_revert_redeemIfTriggerTimeZero() public {
        // WHY: windDown set but triggerTime still zero means wind-down has not been
        // triggered. The explicit check provides a clearer error than the subsequent
        // arithmetic check on `block.timestamp >= 0 + REDEMPTION_DELAY` would imply.
        ArmadaRedemption fresh = new ArmadaRedemption(
            address(armToken), treasuryAddr, revenueLock, crowdfund
        );
        MockWindDownRedemption freshWD = new MockWindDownRedemption();
        fresh.setWindDown(address(freshWD));
        // triggerTime left at 0
        vm.prank(alice);
        armToken.approve(address(fresh), type(uint256).max);
        address[] memory tokens = new address[](0);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: wind-down not triggered");
        fresh.redeem(100e18, tokens, true);
    }

    // ======== anyPayout Guard (issue #254) ========

    function test_revert_redeem_beforeSweep_armLockedButNoPayout() public {
        // WHY: Core issue #254 scenario. Simulate wind-down triggered and delay
        // elapsed but NO sweeps have run — the redemption contract holds nothing
        // for the tokens the user lists. Previously this locked ARM forever; now
        // it reverts and the user keeps their ARM.
        // Tokens are in setUp's redemption contract, so use a pair of fresh tokens
        // that have zero balance on redemption to model "not yet swept".
        MockTokenRedemption usdcNew = new MockTokenRedemption("USDC2", "USDC2");
        MockTokenRedemption wethNew = new MockTokenRedemption("WETH2", "WETH2");
        address[] memory tokens = new address[](2);
        if (address(usdcNew) < address(wethNew)) {
            tokens[0] = address(usdcNew);
            tokens[1] = address(wethNew);
        } else {
            tokens[0] = address(wethNew);
            tokens[1] = address(usdcNew);
        }

        uint256 aliceArm = armToken.balanceOf(alice);
        uint256 aliceArmBefore = aliceArm;

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for token");
        redemption.redeem(aliceArm, tokens, false);

        // Critical invariant: ARM must stay with Alice after the revert
        assertEq(armToken.balanceOf(alice), aliceArmBefore);
        assertEq(armToken.balanceOf(address(redemption)), 0);
    }

    function test_revert_multiTokenAllZeroBalances() public {
        // WHY: The strict per-asset share check must trigger on the FIRST un-swept
        // token when multiple are listed. Covers the variant where users batch
        // several unswept assets in the hope of saving a redeem call.
        MockTokenRedemption a = new MockTokenRedemption("A", "A");
        MockTokenRedemption b = new MockTokenRedemption("B", "B");
        MockTokenRedemption c = new MockTokenRedemption("C", "C");
        address[] memory raw = new address[](3);
        raw[0] = address(a); raw[1] = address(b); raw[2] = address(c);
        // Sort ascending (the contract enforces this)
        address[] memory tokens = new address[](3);
        tokens[0] = raw[0];
        tokens[1] = raw[1];
        tokens[2] = raw[2];
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (tokens[i] > tokens[j]) {
                    (tokens[i], tokens[j]) = (tokens[j], tokens[i]);
                }
            }
        }

        uint256 aliceArm = armToken.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for token");
        redemption.redeem(aliceArm, tokens, false);
    }

    function test_revert_includeETH_noEth_noTokens() public {
        // WHY: includeETH=true with no ETH in the contract and an empty tokens list
        // must revert. Covers the ETH-only variant of the zero-payout footgun.
        address[] memory tokens = new address[](0);
        uint256 aliceArm = armToken.balanceOf(alice);
        assertEq(address(redemption).balance, 0);

        vm.prank(alice);
        vm.expectRevert("ArmadaRedemption: zero share for ETH");
        redemption.redeem(aliceArm, tokens, true);
    }

    // ======== Constructor Validation ========

    function test_constructorRejectsZeroArmToken() public {
        vm.expectRevert("ArmadaRedemption: zero armToken");
        new ArmadaRedemption(address(0), treasuryAddr, revenueLock, crowdfund);
    }

    function test_constructorRejectsZeroTreasury() public {
        vm.expectRevert("ArmadaRedemption: zero treasury");
        new ArmadaRedemption(address(armToken), address(0), revenueLock, crowdfund);
    }

    function test_constructorRejectsZeroRevenueLock() public {
        vm.expectRevert("ArmadaRedemption: zero revenueLock");
        new ArmadaRedemption(address(armToken), treasuryAddr, address(0), crowdfund);
    }

    function test_constructorRejectsZeroCrowdfund() public {
        vm.expectRevert("ArmadaRedemption: zero crowdfund");
        new ArmadaRedemption(address(armToken), treasuryAddr, revenueLock, address(0));
    }
}
