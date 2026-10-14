// ABOUTME: Invariant suites: the yield vault's protocol fee equals the fee rate times all yield generated,
// ABOUTME: with shares redeemed by their depositor, and with shares changing hands before redemption (#608).
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title YieldFeeHandler — deposits, redemptions, share transfers and time, with yield tracking
/// @dev "Yield generated" is measured from outside the vault's own bookkeeping:
///      everything that left or is still in the vault, minus everything deposited.
contract YieldFeeHandler is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    address[] public actors;

    uint256 public totalDeposited;
    uint256 public totalRedeemed;

    constructor(ArmadaYieldVault _vault, MockUSDCV2 _usdc, address[] memory _actors) {
        vault = _vault;
        usdc = _usdc;
        actors = _actors;
    }

    /// @notice All yield the spoke has generated for the vault, net of nothing.
    function yieldGenerated() public view returns (uint256) {
        uint256 out = vault.totalAssets() + totalRedeemed + vault.cumulativeProtocolFee();
        return out > totalDeposited ? out - totalDeposited : 0;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        amount = bound(amount, 1e6, 1_000_000e6);
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        try vault.deposit(amount, actor) {
            totalDeposited += amount;
        } catch {}
        vm.stopPrank();
    }

    /// @notice A holder redeems some of its own shares.
    function redeem(uint256 actorSeed, uint256 shareSeed) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 balance = vault.balanceOf(actor);
        if (balance == 0) return;
        uint256 shares = bound(shareSeed, 1, balance);
        vm.prank(actor);
        try vault.redeem(shares, actor, actor) returns (uint256 assets) {
            totalRedeemed += assets;
        } catch {}
    }

    /// @notice Shares move to another holder, as when ayUSDC is unshielded to a user (F5).
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 shareSeed) external {
        address from = actors[bound(fromSeed, 0, actors.length - 1)];
        address to = actors[bound(toSeed, 0, actors.length - 1)];
        uint256 balance = vault.balanceOf(from);
        if (balance == 0 || from == to) return;
        uint256 shares = bound(shareSeed, 1, balance);
        vm.prank(from);
        vault.transfer(to, shares);
    }

    function advanceTime(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 90 days));
    }

    function harvest() external {
        try vault.harvestProtocolFee() {} catch {}
    }
}

/// @dev Shared setup and checks for the two invariant suites.
abstract contract YieldFeeSetup is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    YieldFeeHandler public handler;

    function _deploy() internal {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        MockAaveSpoke spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), 500, true); // 5% APY
        ArmadaTreasuryGov treasury = new ArmadaTreasuryGov(address(this));
        vault = new ArmadaYieldVault(address(spoke), 0, address(treasury), "Armada Yield USDC", "ayUSDC");

        address[] memory actors = new address[](4);
        for (uint256 i = 0; i < actors.length; i++) actors[i] = address(uint160(0x7100 + i));
        handler = new YieldFeeHandler(vault, usdc, actors);
        usdc.addMinter(address(handler));
    }

    /// @dev The protocol's fee (collected + pending) must equal yieldFeeBps of all yield generated,
    ///      within rounding: 0.001% of the yield plus 1,000 wei.
    function _assertFeeMatchesYield() internal view {
        uint256 generated = handler.yieldGenerated();
        uint256 expected = (generated * vault.yieldFeeBps()) / 10000;
        uint256 actual = vault.cumulativeProtocolFee() + vault.pendingProtocolFee();
        uint256 tolerance = generated / 100_000 + 1_000;
        assertApproxEqAbs(actual, expected, tolerance, "protocol fee != fee rate x yield generated");
    }

    function _target(bool withTransfers) internal {
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](withTransfers ? 5 : 4);
        selectors[0] = YieldFeeHandler.deposit.selector;
        selectors[1] = YieldFeeHandler.redeem.selector;
        selectors[2] = YieldFeeHandler.advanceTime.selector;
        selectors[3] = YieldFeeHandler.harvest.selector;
        if (withTransfers) selectors[4] = YieldFeeHandler.transferShares.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }
}

/// @title Holders redeem only shares they deposited
contract YieldFeeAccountingInvariantTest is YieldFeeSetup {
    function setUp() public {
        _deploy();
        _target(false);
    }

    /// @dev WHY: the protocol is owed yieldFeeBps of every unit of yield the vault earns, whatever
    ///      the order of deposits, redemptions and harvests.
    function invariant_protocolFeeMatchesYield() public view {
        _assertFeeMatchesYield();
    }

    /// @dev WHY: deterministic form of the simplest failing sequence — one holder earns yield and
    ///      redeems, a second holder deposits and earns yield. The fee on the second year's yield
    ///      must still be yieldFeeBps of it.
    function test_feeOnYieldEarnedAfterARedemption() public {
        handler.deposit(0, 1_000_000e6);                    // holder 0
        vm.warp(block.timestamp + 365 days);
        handler.redeem(0, vault.balanceOf(handler.actors(0))); // holder 0 redeems everything
        handler.deposit(1, 1_000_000e6);                    // holder 1
        vm.warp(block.timestamp + 365 days);
        _assertFeeMatchesYield();
    }

    /// @dev WHY: a fee-rate change must apply only to yield earned after it. Otherwise raising the
    ///      rate would instantly claim the higher rate on all uncollected past yield.
    function test_feeRateChangeIsNotRetroactive() public {
        handler.deposit(0, 1_000_000e6);
        vm.warp(block.timestamp + 365 days);
        uint256 yieldAtOldRate = handler.yieldGenerated();

        vault.setYieldFeeBps(2000); // 10% -> 20%
        vm.warp(block.timestamp + 365 days);
        uint256 yieldAtNewRate = handler.yieldGenerated() - yieldAtOldRate;

        uint256 expected = (yieldAtOldRate * 1000) / 10000 + (yieldAtNewRate * 2000) / 10000;
        uint256 actual = vault.cumulativeProtocolFee() + vault.pendingProtocolFee();
        assertApproxEqAbs(actual, expected, 1_000, "rate change applied retroactively");
    }

    /// @dev WHY: after a loss, yield that only recovers the loss is not new yield and must not be
    ///      charged again (high-water mark). Fees resume only on yield above the previous peak.
    function test_noFeeOnRecoveringALoss() public {
        handler.deposit(0, 1_000_000e6);
        vm.warp(block.timestamp + 365 days);
        handler.harvest(); // fee on year 1 collected; high-water mark = year-1 yield
        uint256 collected = vault.cumulativeProtocolFee();
        assertGt(collected, 0, "year-1 fee collected");

        // Simulate a 30k loss in the spoke, then check nothing is owed while below the peak.
        uint256 assets = vault.totalAssets();
        vm.mockCall(
            address(vault.spoke()),
            abi.encodeWithSelector(IAaveSpoke.getUserSuppliedAssets.selector, uint256(0), address(vault)),
            abi.encode(assets - 30_000e6)
        );
        assertEq(vault.pendingProtocolFee(), 0, "fee owed while below the high-water mark");
        vm.clearMockedCalls();

        // Back to the peak: still nothing owed, and nothing new was collected.
        assertEq(vault.pendingProtocolFee(), 0, "fee owed on recovered loss");
        assertEq(vault.cumulativeProtocolFee(), collected);
    }
}

/// @title Shares change hands before redemption (F5)
contract YieldFeeAccountingWithTransfersInvariantTest is YieldFeeSetup {
    function setUp() public {
        _deploy();
        _target(true);
    }

    /// @dev WHY: ayUSDC can leave the adapter — a shielded ayUSDC note can be unshielded to any
    ///      address, which can then redeem directly. The fee owed must not depend on who redeems.
    function invariant_protocolFeeMatchesYieldWhenSharesMove() public view {
        _assertFeeMatchesYield();
    }
}
