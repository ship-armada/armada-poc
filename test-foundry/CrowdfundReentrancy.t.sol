// ABOUTME: Reentrancy tests using malicious ERC20 tokens with transfer hooks.
// ABOUTME: Verifies nonReentrant modifier blocks reentry on claim, claimRefund, and commit.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/crowdfund/ArmadaCrowdfund.sol";
import "../contracts/crowdfund/IArmadaCrowdfund.sol";
import "../contracts/governance/ArmadaToken.sol";
import "../contracts/cctp/MockUSDCV2.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that fires a callback into a target contract during transfer.
///         Simulates ERC777-style reentrancy attacks. The callback result is captured
///         (not propagated) so the outer transfer completes — this lets us verify that
///         the nonReentrant guard blocked the reentry without disrupting the legitimate call.
contract MaliciousERC20 is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public attackActive;
    bool public attackFired;
    /// @notice Whether the reentry callback succeeded (false = blocked by nonReentrant)
    bool public callSucceeded;
    /// @notice Revert data from a failed reentry callback (for asserting revert reason)
    bytes public revertData;

    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arm the attack. On the next transfer, the contract will call
    ///         attackTarget with attackCalldata. The attackFired flag is set
    ///         BEFORE the callback to prevent infinite recursion.
    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        attackActive = true;
        attackFired = false;
        callSucceeded = false;
        revertData = "";
    }

    function disableAttack() external {
        attackActive = false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (attackActive && !attackFired) {
            attackFired = true;
            (bool success, bytes memory ret) = attackTarget.call(attackCalldata);
            callSucceeded = success;
            if (!success) {
                revertData = ret;
            }
        }
    }
}

/// @notice Variant that propagates the reentry revert, causing the outer call to also revert.
///         This simulates an attacker who requires reentry to succeed (all-or-nothing).
contract MaliciousERC20Propagating is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public attackActive;
    bool public attackFired;

    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
        attackActive = true;
        attackFired = false;
    }

    function disableAttack() external {
        attackActive = false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (attackActive && !attackFired) {
            attackFired = true;
            (bool success, bytes memory ret) = attackTarget.call(attackCalldata);
            // Propagate the revert — if reentry is blocked, the entire transfer reverts
            if (!success) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

contract CrowdfundReentrancyTest is Test {
    MockUSDCV2 public usdc;
    ArmadaToken public armToken;
    address public admin;
    address public treasury;

    uint256 constant ARM_FUNDING = 1_800_000 * 1e18;
    uint256 constant HOP0_CAP = 15_000 * 1e6;

    function setUp() public {
        admin = address(this);
        treasury = address(0xCAFE);

        usdc = new MockUSDCV2("Mock USDC", "USDC");
        armToken = new ArmadaToken(admin, admin);

        address[] memory wl = new address[](1);
        wl[0] = admin;
        armToken.initWhitelist(wl);
    }

    // ============ Helpers ============

    /// @notice Extract the revert reason string from raw revert data.
    ///         Assumes Error(string) encoding: 4-byte selector + abi-encoded string.
    function _extractRevertReason(bytes memory data) internal pure returns (string memory) {
        require(data.length >= 4, "revert data too short");
        // Strip the 4-byte Error(string) selector, then abi-decode the string
        bytes memory payload = new bytes(data.length - 4);
        for (uint256 i = 4; i < data.length; i++) {
            payload[i - 4] = data[i];
        }
        return abi.decode(payload, (string));
    }

    /// @notice Build address arrays for a crowdfund with multi-hop demand.
    ///         Does NOT add seeds — caller must loadArm() first, then addSeeds().
    function _buildAddresses()
        internal pure returns (address[] memory seeds, address[] memory hop1)
    {
        seeds = new address[](53);
        for (uint256 i = 0; i < 53; i++) {
            seeds[i] = address(uint160(0xA000 + i));
        }
        hop1 = new address[](53);
        for (uint256 i = 0; i < 53; i++) {
            hop1[i] = address(uint160(0xB000 + i));
        }
    }

    // ============ Test: claim() reentry blocked (silent catch) ============

    /// @notice Malicious ARM token fires callback during claim() → safeTransfer().
    ///         The reentry attempt is caught by the malicious token (not propagated).
    ///         Verifies: reentry failed, outer claim completed, no double-counting.
    function test_reentrancy_claim_reentryBlocked() public {
        MaliciousERC20 maliciousArm = new MaliciousERC20("Bad ARM", "BARM", 18);

        ArmadaCrowdfund cf = new ArmadaCrowdfund(
            address(usdc), address(maliciousArm), treasury, admin, admin, block.timestamp, false
        );
        maliciousArm.mint(address(cf), ARM_FUNDING);
        cf.loadArm();

        (address[] memory seeds, address[] memory hop1) = _buildAddresses();
        cf.addSeeds(seeds);

        // All seeds commit at hop-0
        for (uint256 i = 0; i < seeds.length; i++) {
            usdc.mint(seeds[i], HOP0_CAP);
            vm.startPrank(seeds[i]);
            usdc.approve(address(cf), HOP0_CAP);
            cf.commit(0, HOP0_CAP);
            vm.stopPrank();
        }

        // Invite and commit hop-1
        for (uint256 i = 0; i < hop1.length; i++) {
            vm.prank(seeds[i]);
            cf.invite(hop1[i], 0);
            uint256 hop1Amt = 4_000 * 1e6;
            usdc.mint(hop1[i], hop1Amt);
            vm.startPrank(hop1[i]);
            usdc.approve(address(cf), hop1Amt);
            cf.commit(1, hop1Amt);
            vm.stopPrank();
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();
        assertFalse(cf.refundMode());

        // Arm: on ARM transfer, try to call claim() again
        maliciousArm.setAttack(
            address(cf),
            abi.encodeWithSelector(ArmadaCrowdfund.claim.selector, address(0))
        );

        uint256 armBefore = maliciousArm.balanceOf(seeds[0]);
        vm.prank(seeds[0]);
        cf.claim(address(0));

        // Reentry was attempted and blocked by nonReentrant specifically
        assertTrue(maliciousArm.attackFired(), "Attack callback must have fired");
        assertFalse(maliciousArm.callSucceeded(), "Reentry call must have been blocked");
        assertEq(
            _extractRevertReason(maliciousArm.revertData()),
            "ReentrancyGuard: reentrant call",
            "Reentry must be blocked by nonReentrant guard, not another check"
        );

        // Verify only one claim went through (no double ARM)
        uint256 armReceived = maliciousArm.balanceOf(seeds[0]) - armBefore;
        uint256 expectedArm = cf.addressArmAllocation(seeds[0]);
        assertEq(armReceived, expectedArm, "Must receive exactly one allocation, not double");

        // Second claim must revert (already claimed)
        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: ARM already claimed");
        cf.claim(address(0));
    }

    // ============ Test: claim() reentry blocked (propagating revert) ============

    /// @notice Same attack but the malicious token propagates the revert.
    ///         The entire claim() reverts. Attacker gets nothing.
    function test_reentrancy_claim_propagatingRevert() public {
        MaliciousERC20Propagating maliciousArm =
            new MaliciousERC20Propagating("Bad ARM", "BARM", 18);

        ArmadaCrowdfund cf = new ArmadaCrowdfund(
            address(usdc), address(maliciousArm), treasury, admin, admin, block.timestamp, false
        );
        maliciousArm.mint(address(cf), ARM_FUNDING);
        cf.loadArm();

        (address[] memory seeds, address[] memory hop1) = _buildAddresses();
        cf.addSeeds(seeds);

        for (uint256 i = 0; i < seeds.length; i++) {
            usdc.mint(seeds[i], HOP0_CAP);
            vm.startPrank(seeds[i]);
            usdc.approve(address(cf), HOP0_CAP);
            cf.commit(0, HOP0_CAP);
            vm.stopPrank();
        }

        for (uint256 i = 0; i < hop1.length; i++) {
            vm.prank(seeds[i]);
            cf.invite(hop1[i], 0);
            uint256 hop1Amt = 4_000 * 1e6;
            usdc.mint(hop1[i], hop1Amt);
            vm.startPrank(hop1[i]);
            usdc.approve(address(cf), hop1Amt);
            cf.commit(1, hop1Amt);
            vm.stopPrank();
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();

        maliciousArm.setAttack(
            address(cf),
            abi.encodeWithSelector(ArmadaCrowdfund.claim.selector, address(0))
        );

        // Outer call reverts because reentry revert propagates through the token transfer.
        // The propagated revert reason must be the nonReentrant guard.
        vm.prank(seeds[0]);
        vm.expectRevert("ReentrancyGuard: reentrant call");
        cf.claim(address(0));

        // Attacker received nothing
        assertEq(maliciousArm.balanceOf(seeds[0]), 0, "Attacker must receive nothing");

        // Disable attack — legitimate claim works
        maliciousArm.disableAttack();
        vm.prank(seeds[0]);
        cf.claim(address(0));
        assertTrue(maliciousArm.balanceOf(seeds[0]) > 0, "Legitimate claim must succeed");
    }

    // ============ Test: claimRefund() reentry blocked ============

    /// @notice Malicious USDC fires callback during claimRefund() → safeTransfer().
    ///         Verifies reentry is blocked and no double-refund occurs.
    function test_reentrancy_claimRefund_reentryBlocked() public {
        MaliciousERC20 maliciousUsdc = new MaliciousERC20("Bad USDC", "BUSDC", 6);

        ArmadaCrowdfund cf = new ArmadaCrowdfund(
            address(maliciousUsdc),
            address(armToken),
            treasury,
            admin,
            admin,
            block.timestamp,
            false
        );

        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();

        // 80 seeds, all hop-0 → refundMode
        address[] memory seeds = new address[](80);
        for (uint256 i = 0; i < 80; i++) {
            seeds[i] = address(uint160(0xC000 + i));
        }
        cf.addSeeds(seeds);

        for (uint256 i = 0; i < seeds.length; i++) {
            maliciousUsdc.mint(seeds[i], HOP0_CAP);
            vm.startPrank(seeds[i]);
            maliciousUsdc.approve(address(cf), HOP0_CAP);
            cf.commit(0, HOP0_CAP);
            vm.stopPrank();
        }

        vm.warp(cf.windowEnd() + 1);
        cf.finalize();
        assertTrue(cf.refundMode());

        // Arm: on USDC transfer, try to call claimRefund() again
        maliciousUsdc.setAttack(
            address(cf),
            abi.encodeWithSelector(ArmadaCrowdfund.claimRefund.selector)
        );

        uint256 balBefore = maliciousUsdc.balanceOf(seeds[0]);
        vm.prank(seeds[0]);
        cf.claimRefund();

        // Reentry was attempted and blocked by nonReentrant specifically
        assertTrue(maliciousUsdc.attackFired(), "Attack callback must have fired");
        assertFalse(maliciousUsdc.callSucceeded(), "Reentry call must have been blocked");
        assertEq(
            _extractRevertReason(maliciousUsdc.revertData()),
            "ReentrancyGuard: reentrant call",
            "Reentry must be blocked by nonReentrant guard, not another check"
        );

        // Only one refund went through
        uint256 refundReceived = maliciousUsdc.balanceOf(seeds[0]) - balBefore;
        assertEq(refundReceived, HOP0_CAP, "Must receive exactly committed amount, not double");

        // Second claimRefund must revert (already refunded)
        vm.prank(seeds[0]);
        vm.expectRevert("ArmadaCrowdfund: already refunded");
        cf.claimRefund();
    }

    // ============ Test: commit() reentry blocked ============

    /// @notice Malicious USDC fires callback during commit() → safeTransferFrom().
    ///         The reentry attempt tries to call commit() again, which is blocked
    ///         by nonReentrant. The outer commit completes with no double-counting.
    function test_reentrancy_commit_reentryBlocked() public {
        MaliciousERC20 maliciousUsdc = new MaliciousERC20("Bad USDC", "BUSDC", 6);

        ArmadaCrowdfund cf = new ArmadaCrowdfund(
            address(maliciousUsdc),
            address(armToken),
            treasury,
            admin,
            admin,
            block.timestamp,
            false
        );

        armToken.transfer(address(cf), ARM_FUNDING);
        cf.loadArm();

        address seed = address(uint160(0xF001));
        address[] memory seedArr = new address[](1);
        seedArr[0] = seed;
        cf.addSeeds(seedArr);

        uint256 commitAmt = 1_000 * 1e6;
        maliciousUsdc.mint(seed, commitAmt * 2);
        vm.prank(seed);
        maliciousUsdc.approve(address(cf), commitAmt * 2);

        // Arm: during transferFrom, try to call commit() again
        maliciousUsdc.setAttack(
            address(cf),
            abi.encodeWithSelector(ArmadaCrowdfund.commit.selector, uint8(0), commitAmt)
        );

        vm.prank(seed);
        cf.commit(0, commitAmt);

        // Reentry was attempted and blocked by nonReentrant specifically
        assertTrue(maliciousUsdc.attackFired(), "Attack callback must have fired");
        assertFalse(maliciousUsdc.callSucceeded(), "Reentry call must have been blocked");
        assertEq(
            _extractRevertReason(maliciousUsdc.revertData()),
            "ReentrancyGuard: reentrant call",
            "Reentry must be blocked by nonReentrant guard, not another check"
        );

        // Only one commit recorded (no double-counting)
        assertEq(cf.totalCommitted(), commitAmt, "Must record exactly one commit, not double");
    }
}
