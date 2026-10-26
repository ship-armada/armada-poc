// ABOUTME: Regression tests for #365 — the ArmadaYieldVault first-depositor share-inflation attack.
// ABOUTME: The first deposit locks LOCKED_SHARES forever, so inflating the share price stops paying.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title YieldInflationDefenseTest — the #365 attack no longer pays, and the share lock holds.
/// @dev The attack: the first depositor holds 1 share, then donates straight into the vault's spoke
///      position (`spoke.supply(..., address(vault))` credits any `onBehalfOf`). One share becomes
///      hugely expensive, so the next deposit loses up to a whole share to rounding and the attacker
///      redeems part of it. Before the fix a 150k victim lost 30k and the attacker gained 20k.
///      The defense: the first deposit mints LOCKED_SHARES to an address nobody controls, so total
///      supply never drops below LOCKED_SHARES and a donation is spread over shares the attacker
///      does not own.
contract YieldInflationDefenseTest is Test {
    ArmadaYieldVault vault;
    MockUSDCV2 usdc;
    MockAaveSpoke spoke;
    ArmadaTreasuryGov treasury;

    address attacker = address(0xA11CE);
    address victim = address(0x71C71);

    uint256 constant DONATION = 100_000e6; // 100k USDC donated directly into the vault's spoke position
    uint256 constant VICTIM_DEPOSIT = 150_000e6; // victim's honest deposit

    function setUp() public {
        usdc = new MockUSDCV2("Mock USDC", "USDC");
        spoke = new MockAaveSpoke();
        usdc.addMinter(address(spoke));
        spoke.addReserve(address(usdc), 500, true); // 5% APY reserve, reserveId 0
        treasury = new ArmadaTreasuryGov(address(this));
        vault = new ArmadaYieldVault(address(spoke), 0, address(treasury), "Armada Yield USDC", "ayUSDC");
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    function _donate(address who, uint256 assets) internal {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(spoke), assets);
        spoke.supply(0, assets, address(vault));
        vm.stopPrank();
    }

    /// @notice WHY: the original #365 exploit, replayed against the fixed vault. The attacker can no
    ///         longer start from a 1-unit deposit, and from the smallest allowed first deposit the
    ///         donation is spread over the locked shares, so the attacker loses almost all of it and
    ///         the victim loses less than one share's value to rounding.
    function test_inflationAttackIsUnprofitable() public {
        uint256 locked = vault.LOCKED_SHARES();

        // A 1-unit first deposit — the start of the original attack — is rejected.
        usdc.mint(attacker, 1);
        vm.startPrank(attacker);
        usdc.approve(address(vault), 1);
        vm.expectRevert("ArmadaYieldVault: first deposit too small");
        vault.deposit(1, attacker);
        vm.stopPrank();

        // The cheapest first deposit leaves the attacker holding 1 share.
        uint256 attackerShares = _deposit(attacker, locked + 1);
        assertEq(attackerShares, 1, "attacker holds 1 share");

        _donate(attacker, DONATION);
        uint256 sharePrice = vault.convertToAssets(1);
        assertLt(sharePrice, 1e6, "donation moves one share's price by under 1 USDC");

        uint256 victimShares = _deposit(victim, VICTIM_DEPOSIT);
        uint256 victimClaimable = vault.convertToAssets(victimShares);
        assertGe(victimClaimable + sharePrice, VICTIM_DEPOSIT, "victim loses less than one share to rounding");

        vm.prank(attacker);
        uint256 attackerRedeemed = vault.redeem(attackerShares, attacker, attacker);
        uint256 attackerCost = locked + 1 + DONATION;
        assertLt(attackerRedeemed, attackerCost / 1000, "attacker recovers under 0.1% of what they spent");
    }

    /// @notice WHY: the first deposit pays for the lock; it is priced 1:1 on an empty vault, so 10 USDC
    ///         mints 10e6 shares, of which LOCKED_SHARES go to the lock holder.
    function test_firstDepositLocksShares() public {
        uint256 locked = vault.LOCKED_SHARES();
        address holder = vault.LOCKED_SHARES_HOLDER();

        uint256 shares = _deposit(victim, 10e6);

        assertEq(shares, 10e6 - locked, "depositor receives the rest");
        assertEq(vault.balanceOf(holder), locked, "lock holder holds LOCKED_SHARES");
        assertEq(vault.totalSupply(), 10e6, "supply covers both");
    }

    /// @notice WHY: a first deposit that cannot cover the lock plus at least one share must revert
    ///         rather than leave the vault with fewer locked shares than LOCKED_SHARES.
    function test_firstDepositAtOrBelowLockReverts() public {
        uint256 locked = vault.LOCKED_SHARES();
        usdc.mint(victim, locked);
        vm.startPrank(victim);
        usdc.approve(address(vault), locked);
        vm.expectRevert("ArmadaYieldVault: first deposit too small");
        vault.deposit(locked, victim);
        vm.stopPrank();
    }

    /// @notice WHY: the lock is a one-off; later deposits are priced normally and mint nothing extra.
    function test_onlyFirstDepositLocks() public {
        uint256 locked = vault.LOCKED_SHARES();
        address holder = vault.LOCKED_SHARES_HOLDER();
        _deposit(victim, 10e6);

        uint256 shares = _deposit(attacker, 5e6);

        assertEq(shares, 5e6, "second deposit is priced 1:1 with no yield yet");
        assertEq(vault.balanceOf(holder), locked, "no further shares locked");
    }

    /// @notice WHY: nobody holds a key for the lock holder, so nobody can redeem or move its shares;
    ///         without an allowance from it, redeeming on its behalf must fail.
    function test_lockedSharesCannotBeRedeemed() public {
        address holder = vault.LOCKED_SHARES_HOLDER();
        _deposit(victim, 10e6);

        vm.prank(attacker);
        vm.expectRevert("ArmadaYieldVault: insufficient allowance");
        vault.redeem(1, attacker, holder);
    }

    /// @notice WHY: the protection must survive the vault emptying out. After every real holder
    ///         redeems, the locked shares remain, so the supply never returns to zero. A 1-unit
    ///         deposit is allowed again (it is not the first deposit), so the original attack is
    ///         replayed from there and must be as unprofitable as on day one.
    function test_attackAfterVaultEmptiesIsUnprofitable() public {
        uint256 locked = vault.LOCKED_SHARES();
        uint256 shares = _deposit(victim, 10e6);
        vm.prank(victim);
        vault.redeem(shares, victim, victim);
        assertEq(vault.totalSupply(), locked, "only the locked shares remain");

        uint256 attackerShares = _deposit(attacker, 1);
        _donate(attacker, DONATION);
        uint256 sharePrice = vault.convertToAssets(1);
        assertLt(sharePrice, 1e6, "donation moves one share's price by under 1 USDC");

        uint256 victimShares = _deposit(victim, VICTIM_DEPOSIT);
        assertGe(
            vault.convertToAssets(victimShares) + sharePrice, VICTIM_DEPOSIT, "victim loses less than one share"
        );

        vm.prank(attacker);
        uint256 attackerRedeemed = vault.redeem(attackerShares, attacker, attacker);
        assertLt(attackerRedeemed, (1 + DONATION) / 1000, "attacker recovers under 0.1% of what they spent");
    }
}
