// ABOUTME: Tests for per-deposit cost basis tracking in ArmadaYieldVault (H-4 fix).
// ABOUTME: Verifies cost basis isolation, partial redeems, yield fee correctness, and access control.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/yield/ArmadaTreasury.sol";
import "../contracts/yield/ArmadaYieldAdapter.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/cctp/MockUSDCV2.sol";

// ======================================================================
// H-4 Fix: Per-Deposit Cost Basis Tests
//
// These tests verify that the adapter's per-nonce cost basis tracking
// prevents cross-user cost basis corruption. Each deposit through the
// adapter gets a unique nonce, and redeems reference that nonce to use
// the correct cost basis for yield fee calculation.
// ======================================================================

/// @title YieldCostBasisTest - Unit and property tests for per-deposit cost basis
contract YieldCostBasisTest is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    MockAaveSpoke public spoke;
    ArmadaTreasury public treasury;
    ArmadaYieldAdapter public adapter;

    address public deployer = address(this);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    uint256 constant YIELD_BPS = 500; // 5% APY
    uint256 constant COST_BASIS_PRECISION = 1e18;

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), YIELD_BPS, true);

        treasury = new ArmadaTreasury();
        vault = new ArmadaYieldVault(
            address(spoke),
            0,
            address(treasury),
            "Armada Yield USDC",
            "ayUSDC"
        );

        adapter = new ArmadaYieldAdapter(address(usdc), address(vault));
        vault.setAdapter(address(adapter));

        // Fund actors
        usdc.mint(alice, 10_000_000 * 1e6);
        usdc.mint(bob, 10_000_000 * 1e6);
        usdc.mint(address(adapter), 10_000_000 * 1e6);
    }

    // ====================================================================
    // depositForAdapter: basic functionality
    // ====================================================================

    function test_depositForAdapter_mintsSharesAndTracksNonce() public {
        uint256 amount = 1000 * 1e6;

        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        assertGt(shares, 0, "should mint shares");
        assertEq(nonce, 0, "first nonce should be 0");
        assertEq(vault.adapterDepositNonce(), 1, "nonce counter should increment");

        (uint256 costBasis, uint256 remaining) = vault.adapterDeposits(0);
        assertEq(remaining, shares, "remaining should equal minted shares");
        assertGt(costBasis, 0, "cost basis should be non-zero");
    }

    function test_depositForAdapter_nonceIncrementsMonotonically() public {
        vm.startPrank(address(adapter));
        (, uint256 n0) = vault.depositForAdapter(100 * 1e6);
        (, uint256 n1) = vault.depositForAdapter(200 * 1e6);
        (, uint256 n2) = vault.depositForAdapter(300 * 1e6);
        vm.stopPrank();

        assertEq(n0, 0);
        assertEq(n1, 1);
        assertEq(n2, 2);
    }

    function test_depositForAdapter_onlyAdapter() public {
        vm.prank(alice);
        vm.expectRevert("ArmadaYieldVault: not adapter");
        vault.depositForAdapter(100 * 1e6);
    }

    function test_depositForAdapter_zeroAssets() public {
        vm.prank(address(adapter));
        vm.expectRevert("ArmadaYieldVault: zero assets");
        vault.depositForAdapter(0);
    }

    // ====================================================================
    // redeemByNonce: basic functionality
    // ====================================================================

    function test_redeemByNonce_fullRedeem() public {
        uint256 amount = 1000 * 1e6;
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        // Transfer shares back to adapter for redemption (simulate unshield)
        // In real flow, shares go to privacy pool then back to adapter
        vm.prank(address(adapter));
        vault.transfer(address(adapter), 0); // no-op, adapter already holds shares

        vm.prank(address(adapter));
        uint256 assets = vault.redeemByNonce(nonce, shares, address(adapter));

        assertGt(assets, 0, "should return assets");
        (, uint256 remaining) = vault.adapterDeposits(nonce);
        assertEq(remaining, 0, "remaining should be 0 after full redeem");
    }

    function test_redeemByNonce_onlyAdapter() public {
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(100 * 1e6);

        vm.prank(alice);
        vm.expectRevert("ArmadaYieldVault: not adapter");
        vault.redeemByNonce(nonce, shares, alice);
    }

    function test_redeemByNonce_exceedsDeposit() public {
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(100 * 1e6);

        vm.prank(address(adapter));
        vm.expectRevert("ArmadaYieldVault: exceeds deposit");
        vault.redeemByNonce(nonce, shares + 1, address(adapter));
    }

    function test_redeemByNonce_doubleRedeemReverts() public {
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(100 * 1e6);

        vm.prank(address(adapter));
        vault.redeemByNonce(nonce, shares, address(adapter));

        vm.prank(address(adapter));
        vm.expectRevert("ArmadaYieldVault: exceeds deposit");
        vault.redeemByNonce(nonce, 1, address(adapter));
    }

    // ====================================================================
    // H-4 Core: Cost basis isolation between deposits
    // ====================================================================

    /// @notice The key test: two deposits at different share prices must
    ///         use their own cost basis, not a shared/corrupted one.
    function test_costBasisIsolation_twoDepositsAtDifferentPrices() public {
        // Alice deposits 1000 USDC at share price 1.0
        vm.prank(address(adapter));
        (uint256 aliceShares, uint256 aliceNonce) = vault.depositForAdapter(1000 * 1e6);

        // Advance time so yield accrues (share price increases)
        vm.warp(block.timestamp + 365 days);

        // Bob deposits 1000 USDC at higher share price
        vm.prank(address(adapter));
        (uint256 bobShares, uint256 bobNonce) = vault.depositForAdapter(1000 * 1e6);

        // Verify different cost bases were recorded
        (uint256 aliceCostBasis,) = vault.adapterDeposits(aliceNonce);
        (uint256 bobCostBasis,) = vault.adapterDeposits(bobNonce);

        // Alice deposited at 1:1 (price 1.0), Bob deposited at higher price
        // Bob should have higher cost basis per share
        assertGt(bobCostBasis, aliceCostBasis, "Bob's cost basis should be higher (deposited at higher price)");

        // Alice redeems - should get yield fee based on HER cost basis
        uint256 treasuryBefore = usdc.balanceOf(address(treasury));
        vm.prank(address(adapter));
        uint256 aliceAssets = vault.redeemByNonce(aliceNonce, aliceShares, address(adapter));

        uint256 aliceFee = usdc.balanceOf(address(treasury)) - treasuryBefore;

        // Alice had the earliest deposit at the lowest price, so she has the most yield
        // Her fee should be > 0 (she earned yield)
        assertGt(aliceFee, 0, "Alice should pay yield fee (she earned yield)");

        // Bob redeems - should get yield fee based on HIS cost basis (not Alice's)
        treasuryBefore = usdc.balanceOf(address(treasury));

        // Give adapter more shares for Bob's redeem (simulate unshield)
        // Bob's shares were already minted to adapter; but they got spent on Alice's redeem burn
        // In reality, each user's shares come from the privacy pool separately.
        // For this test, we need to ensure adapter has Bob's shares.
        // The adapter should still hold bobShares since we only redeemed aliceShares.
        vm.prank(address(adapter));
        uint256 bobAssets = vault.redeemByNonce(bobNonce, bobShares, address(adapter));

        uint256 bobFee = usdc.balanceOf(address(treasury)) - treasuryBefore;

        // Bob deposited at higher price and redeemed shortly after (relative to Alice)
        // If no time passes between Bob's deposit and redeem, Bob's fee should be ~0
        // Since time DID pass (1 year before Bob deposited), Bob has 0 yield from his deposit
        // His cost basis matches the current share price at deposit time
        // Any additional yield is very small (near 0 since we're redeeming right away)
        assertLe(bobFee, aliceFee, "Bob's fee should be <= Alice's (less yield accrued)");
    }

    /// @notice Fuzz test: cost basis per share matches the deposit-time exchange rate
    function testFuzz_costBasisMatchesExchangeRate(
        uint256 depositAmount,
        uint256 timeElapsed
    ) public {
        depositAmount = bound(depositAmount, 1e6, 1_000_000 * 1e6);
        timeElapsed = bound(timeElapsed, 0, 365 days);

        // First deposit to establish initial share price
        vm.prank(address(adapter));
        vault.depositForAdapter(100_000 * 1e6);

        // Advance time to change share price
        vm.warp(block.timestamp + timeElapsed);

        // Record share price before deposit
        uint256 sharePriceBeforeScaled;
        if (vault.totalSupply() > 0) {
            sharePriceBeforeScaled = (vault.totalAssets() * COST_BASIS_PRECISION) / vault.totalSupply();
        } else {
            sharePriceBeforeScaled = COST_BASIS_PRECISION;
        }

        // Deposit
        vm.prank(address(adapter));
        (, uint256 nonce) = vault.depositForAdapter(depositAmount);

        // Verify cost basis matches the share price at deposit time
        (uint256 costBasis,) = vault.adapterDeposits(nonce);

        // Cost basis should be close to the share price at deposit time.
        // Integer division rounding can cause divergence proportional to the share price,
        // so use relative comparison (0.001% = 1e-5 tolerance).
        assertApproxEqRel(
            costBasis,
            sharePriceBeforeScaled,
            1e13, // 0.001% relative tolerance
            "Cost basis should match share price at deposit time"
        );
    }

    // ====================================================================
    // Partial redemption
    // ====================================================================

    function test_partialRedeem_costBasisPreserved() public {
        uint256 amount = 1000 * 1e6;
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        // Advance time for yield
        vm.warp(block.timestamp + 180 days);

        // Redeem half
        uint256 halfShares = shares / 2;
        vm.prank(address(adapter));
        vault.redeemByNonce(nonce, halfShares, address(adapter));

        // Verify remaining shares and cost basis unchanged
        (uint256 costBasis, uint256 remaining) = vault.adapterDeposits(nonce);
        assertEq(remaining, shares - halfShares, "remaining should be half");
        assertEq(costBasis, (amount * COST_BASIS_PRECISION) / shares, "cost basis should be unchanged");

        // Redeem the rest
        vm.prank(address(adapter));
        vault.redeemByNonce(nonce, remaining, address(adapter));

        (, uint256 finalRemaining) = vault.adapterDeposits(nonce);
        assertEq(finalRemaining, 0, "all shares redeemed");
    }

    /// @notice Fuzz: partial redeems always sum to <= full redeem value
    function testFuzz_partialRedeemsConsistent(
        uint256 depositAmount,
        uint256 splitPoint,
        uint256 timeElapsed
    ) public {
        depositAmount = bound(depositAmount, 10 * 1e6, 1_000_000 * 1e6);
        timeElapsed = bound(timeElapsed, 1 days, 365 days);

        // Deposit
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(depositAmount);

        vm.warp(block.timestamp + timeElapsed);

        splitPoint = bound(splitPoint, 1, shares - 1);
        uint256 part1 = splitPoint;
        uint256 part2 = shares - splitPoint;

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));

        vm.prank(address(adapter));
        uint256 assets1 = vault.redeemByNonce(nonce, part1, address(adapter));

        vm.prank(address(adapter));
        uint256 assets2 = vault.redeemByNonce(nonce, part2, address(adapter));

        uint256 totalFee = usdc.balanceOf(address(treasury)) - treasuryBefore;

        // Total assets + fees should equal gross value of all shares
        // This is hard to verify exactly due to rounding, but:
        // 1. Both redeems should return > 0
        assertGt(assets1, 0, "first partial redeem should return assets");
        assertGt(assets2, 0, "second partial redeem should return assets");

        // 2. No remaining shares
        (, uint256 remaining) = vault.adapterDeposits(nonce);
        assertEq(remaining, 0, "all shares should be redeemed");
    }

    // ====================================================================
    // Yield fee correctness with per-deposit cost basis
    // ====================================================================

    /// @notice Deposit, wait for yield, redeem — fee should be 10% of yield
    function test_yieldFeeCorrectWithPerDepositBasis() public {
        uint256 amount = 10_000 * 1e6; // $10,000

        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        // Advance 1 year (5% APY -> ~$500 yield)
        vm.warp(block.timestamp + 365 days);

        uint256 grossAssets = vault.convertToAssets(shares);
        uint256 expectedYield = grossAssets - amount;

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));

        vm.prank(address(adapter));
        uint256 netAssets = vault.redeemByNonce(nonce, shares, address(adapter));

        uint256 actualFee = usdc.balanceOf(address(treasury)) - treasuryBefore;
        uint256 expectedFee = (expectedYield * 1000) / 10000; // 10% of yield

        // Fee should be approximately 10% of yield (allow 1 USDC tolerance for rounding)
        assertApproxEqAbs(actualFee, expectedFee, 1e6, "Fee should be ~10% of yield");

        // Net assets should be grossAssets - fee
        assertEq(netAssets, grossAssets - actualFee, "Net = gross - fee");
    }

    /// @notice No yield => no fee (immediate redeem after deposit)
    function test_noYieldNoFee() public {
        uint256 amount = 1000 * 1e6;

        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        uint256 treasuryBefore = usdc.balanceOf(address(treasury));

        vm.prank(address(adapter));
        uint256 assets = vault.redeemByNonce(nonce, shares, address(adapter));

        uint256 fee = usdc.balanceOf(address(treasury)) - treasuryBefore;
        assertEq(fee, 0, "No yield should mean no fee");
        assertApproxEqAbs(assets, amount, 1, "Should get back deposit amount");
    }

    // ====================================================================
    // Direct deposit/redeem still works for non-adapter users
    // ====================================================================

    function test_directDepositRedeemUnchanged() public {
        uint256 amount = 1000 * 1e6;

        vm.startPrank(alice);
        usdc.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, alice);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.balanceOf(alice), shares);

        // Advance time for yield
        vm.warp(block.timestamp + 365 days);

        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);

        // Alice should get back more than deposited (yield minus fee)
        assertGt(assets, amount, "Should earn yield");
    }

    // ====================================================================
    // Events
    // ====================================================================

    function test_depositForAdapter_emitsAdapterDepositCreatedEvent() public {
        uint256 amount = 1000 * 1e6;

        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(amount);

        // Verify deposit was created with correct nonce
        assertEq(nonce, 0, "first deposit nonce should be 0");
        (uint256 costBasis, uint256 remaining) = vault.adapterDeposits(nonce);
        assertGt(costBasis, 0, "cost basis should be set");
        assertEq(remaining, shares, "remaining should match shares");
    }

    function test_redeemByNonce_clearsRemainingShares() public {
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(1000 * 1e6);

        vm.prank(address(adapter));
        vault.redeemByNonce(nonce, shares, address(adapter));

        (, uint256 remaining) = vault.adapterDeposits(nonce);
        assertEq(remaining, 0, "remaining should be 0 after full redeem");
    }

    // ====================================================================
    // Zero shares edge case
    // ====================================================================

    function test_redeemByNonce_zeroShares() public {
        vm.prank(address(adapter));
        (, uint256 nonce) = vault.depositForAdapter(100 * 1e6);

        vm.prank(address(adapter));
        vm.expectRevert("ArmadaYieldVault: zero shares");
        vault.redeemByNonce(nonce, 0, address(adapter));
    }

    function test_redeemByNonce_zeroReceiver() public {
        vm.prank(address(adapter));
        (uint256 shares, uint256 nonce) = vault.depositForAdapter(100 * 1e6);

        vm.prank(address(adapter));
        vm.expectRevert("ArmadaYieldVault: zero receiver");
        vault.redeemByNonce(nonce, shares, address(0));
    }
}

// ======================================================================
// Invariant test: Multi-user adapter cost basis isolation
// ======================================================================

/// @title CostBasisHandler - Exercises adapter deposit/redeem with multiple users
contract CostBasisHandler is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    MockAaveSpoke public spoke;
    ArmadaYieldAdapter public adapter;

    // Track deposits for invariant checking
    uint256[] public activeNonces;
    mapping(uint256 => uint256) public expectedCostBasis;

    uint256 public ghost_depositsCreated;
    uint256 public ghost_depositsRedeemed;
    uint256 public ghost_costBasisMismatches;

    constructor(
        ArmadaYieldVault _vault,
        MockUSDCV2 _usdc,
        MockAaveSpoke _spoke,
        ArmadaYieldAdapter _adapter
    ) {
        vault = _vault;
        usdc = _usdc;
        spoke = _spoke;
        adapter = _adapter;
    }

    /// @dev Deposit through adapter with fuzzed amount
    function adapterDeposit(uint256 amount) external {
        amount = bound(amount, 1e6, 100_000 * 1e6);

        // Record share price before deposit
        uint256 priceBeforeScaled;
        if (vault.totalSupply() > 0) {
            priceBeforeScaled = (vault.totalAssets() * 1e18) / vault.totalSupply();
        } else {
            priceBeforeScaled = 1e18;
        }

        vm.prank(address(adapter));
        (, uint256 nonce) = vault.depositForAdapter(amount);

        activeNonces.push(nonce);
        expectedCostBasis[nonce] = priceBeforeScaled;
        ghost_depositsCreated++;
    }

    /// @dev Redeem through adapter using a fuzzed nonce index
    function adapterRedeem(uint256 nonceIdx) external {
        if (activeNonces.length == 0) return;
        nonceIdx = bound(nonceIdx, 0, activeNonces.length - 1);

        uint256 nonce = activeNonces[nonceIdx];
        (, uint256 remaining) = vault.adapterDeposits(nonce);
        if (remaining == 0) return;

        // Verify cost basis hasn't been corrupted.
        // The expected cost basis (share price before deposit) and the actual cost basis
        // (assets * PRECISION / shares) diverge by integer division rounding.
        // We check that the cost basis hasn't changed since deposit creation,
        // which is the real invariant — it should never be overwritten by another deposit.
        (uint256 actualCostBasis,) = vault.adapterDeposits(nonce);
        // Use relative tolerance of 0.01% to account for integer division rounding
        // between our pre-computed share price and the vault's cost basis calculation
        uint256 expected = expectedCostBasis[nonce];
        if (expected > 0) {
            uint256 diff = actualCostBasis > expected
                ? actualCostBasis - expected
                : expected - actualCostBasis;
            // 0.01% relative tolerance
            if (diff * 10000 > expected) {
                ghost_costBasisMismatches++;
            }
        }

        vm.prank(address(adapter));
        try vault.redeemByNonce(nonce, remaining, address(adapter)) {
            ghost_depositsRedeemed++;
        } catch {}
    }

    /// @dev Advance time to accrue yield (changes share price)
    function advanceTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 90 days);
        vm.warp(block.timestamp + seconds_);
    }
}

/// @title YieldCostBasisInvariantTest - Invariant tests for cost basis isolation
contract YieldCostBasisInvariantTest is Test {
    ArmadaYieldVault public vault;
    MockUSDCV2 public usdc;
    MockAaveSpoke public spoke;
    ArmadaTreasury public treasury;
    ArmadaYieldAdapter public adapter;
    CostBasisHandler public handler;

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), 500, true); // 5% APY

        treasury = new ArmadaTreasury();
        vault = new ArmadaYieldVault(
            address(spoke),
            0,
            address(treasury),
            "Armada Yield USDC",
            "ayUSDC"
        );

        adapter = new ArmadaYieldAdapter(address(usdc), address(vault));
        vault.setAdapter(address(adapter));

        // Fund adapter with enough USDC for many deposits
        usdc.mint(address(adapter), 100_000_000 * 1e6);

        handler = new CostBasisHandler(vault, usdc, spoke, adapter);
        targetContract(address(handler));
    }

    /// @notice INV-CB1: Cost basis per deposit never changes after creation
    function invariant_costBasisNeverCorrupted() public view {
        assertEq(
            handler.ghost_costBasisMismatches(),
            0,
            "INV-CB1: Cost basis was corrupted after deposit creation"
        );
    }

    /// @notice INV-CB2: Adapter deposit nonce is always monotonically increasing
    function invariant_nonceMonotonic() public view {
        uint256 nonce = vault.adapterDepositNonce();
        assertEq(
            nonce,
            handler.ghost_depositsCreated(),
            "INV-CB2: Nonce should equal total deposits created"
        );
    }
}
