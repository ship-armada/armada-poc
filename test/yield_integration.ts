/**
 * Yield Integration Tests
 *
 * Tests the full yield flow:
 * - Deposit USDC → ArmadaYieldVault → MockAaveSpoke
 * - Yield accrual over time
 * - Redeem with 10% yield fee
 * - Lend/redeem via adapter
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Yield Integration", function () {
  // Contracts
  let usdc: any;
  let mockAaveSpoke: any;
  let armadaTreasury: any;
  let armadaYieldVault: any;
  let armadaYieldAdapter: any;

  // Signers
  let deployer: SignerWithAddress;
  let user: SignerWithAddress;

  // Constants
  const USDC_DECIMALS = 6;
  const ONE_USDC = ethers.parseUnits("1", USDC_DECIMALS);
  const INITIAL_BALANCE = ethers.parseUnits("10000", USDC_DECIMALS); // 10,000 USDC
  const DEPOSIT_AMOUNT = ethers.parseUnits("1000", USDC_DECIMALS); // 1,000 USDC
  const YIELD_BPS = 500; // 5% APY
  const YIELD_FEE_BPS = 1000; // 10% fee
  const ONE_YEAR = 365 * 24 * 60 * 60;

  beforeEach(async function () {
    [deployer, user] = await ethers.getSigners();

    // 1. Deploy MockUSDCV2
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // 2. Deploy MockAaveSpoke
    const MockAaveSpoke = await ethers.getContractFactory("MockAaveSpoke");
    mockAaveSpoke = await MockAaveSpoke.deploy();
    await mockAaveSpoke.waitForDeployment();

    // 3. Add MockAaveSpoke as USDC minter
    await usdc.addMinter(await mockAaveSpoke.getAddress());

    // 4. Add USDC reserve with 5% APY
    await mockAaveSpoke.addReserve(
      await usdc.getAddress(),
      YIELD_BPS,
      true // mintableYield
    );

    // 5. Deploy ArmadaTreasuryGov (deployer acts as timelock-owner for this unit test).
    //    Outflow withdrawal paths are exercised in test/treasury_outflow.ts and the
    //    Foundry Treasury* suites — here we only need the treasury as a fee sink.
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    armadaTreasury = await ArmadaTreasuryGov.deploy(deployer.address);
    await armadaTreasury.waitForDeployment();

    // 6. Deploy ArmadaYieldVault
    const ArmadaYieldVault = await ethers.getContractFactory("ArmadaYieldVault");
    armadaYieldVault = await ArmadaYieldVault.deploy(
      await mockAaveSpoke.getAddress(),
      0, // reserveId
      await armadaTreasury.getAddress(),
      "Armada Yield USDC",
      "ayUSDC"
    );
    await armadaYieldVault.waitForDeployment();

    // 7. Deploy MockAdapterRegistry and ArmadaYieldAdapter
    const MockAdapterRegistry = await ethers.getContractFactory("MockAdapterRegistry");
    const mockRegistry = await MockAdapterRegistry.deploy();
    await mockRegistry.waitForDeployment();

    const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
    armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
      await usdc.getAddress(),
      await armadaYieldVault.getAddress(),
      await mockRegistry.getAddress()
    );
    await armadaYieldAdapter.waitForDeployment();
    await mockRegistry.setAuthorized(await armadaYieldAdapter.getAddress(), true);

    // 8. Mint USDC to user
    await usdc.mint(user.address, INITIAL_BALANCE);
  });

  describe("ArmadaYieldVault", function () {
    it("should deposit USDC and receive shares", async function () {
      // Approve
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );

      // Deposit
      const tx = await armadaYieldVault.connect(user).deposit(
        DEPOSIT_AMOUNT,
        user.address
      );
      await tx.wait();

      // Check balances (allow small rounding tolerance). The first deposit is priced 1:1 but pays
      // for the permanent share lock (LOCKED_SHARES, #365), so the user receives the rest.
      const lockedShares = await armadaYieldVault.LOCKED_SHARES();
      const shares = await armadaYieldVault.balanceOf(user.address);
      expect(shares).to.be.closeTo(DEPOSIT_AMOUNT - lockedShares, 10n);

      const userUSDC = await usdc.balanceOf(user.address);
      expect(userUSDC).to.be.closeTo(INITIAL_BALANCE - DEPOSIT_AMOUNT, 10n);

      // Check vault state
      const totalAssets = await armadaYieldVault.totalAssets();
      expect(totalAssets).to.be.closeTo(DEPOSIT_AMOUNT, 10n);
    });

    it("should accrue yield over time", async function () {
      // Deposit
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Check initial assets (allow small rounding tolerance). As the first depositor the user paid
      // for the permanent share lock (LOCKED_SHARES, #365).
      const userPrincipal = DEPOSIT_AMOUNT - (await armadaYieldVault.LOCKED_SHARES());
      const initialAssets = await armadaYieldVault.getUserAssets(user.address);
      expect(initialAssets).to.be.closeTo(userPrincipal, 10n);

      // Fast forward 1 year
      await time.increase(ONE_YEAR);

      // Check assets after yield
      // WHY: After issue #75 (harvest-fee refactor), getUserAssets returns the
      //      user-claimable value — i.e. share of (totalAssets - pendingProtocolFee).
      //      For a single depositor that's principal + net-of-protocol-cut yield.
      const assetsAfterYear = await armadaYieldVault.getUserAssets(user.address);

      const expectedGrossYield = (userPrincipal * BigInt(YIELD_BPS)) / 10000n;
      const expectedNetYield = (expectedGrossYield * (10000n - BigInt(YIELD_FEE_BPS))) / 10000n;
      const expectedTotal = userPrincipal + expectedNetYield;

      // Allow 1 USDC tolerance for rounding
      expect(assetsAfterYear).to.be.closeTo(expectedTotal, ONE_USDC);
    });

    it("should apply 10% yield fee on redemption", async function () {
      // Deposit
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Fast forward 1 year
      await time.increase(ONE_YEAR);

      // Get shares
      const shares = await armadaYieldVault.balanceOf(user.address);

      // WHY: After issue #75, getUserAssets and pendingProtocolFee together describe the split:
      //      getUserAssets = what the user's shares are worth net of the protocol's cut,
      //      pendingProtocolFee = the protocol's currently-owed cut. The user's shares were worth
      //      DEPOSIT_AMOUNT less the share lock their first deposit paid for (#365), so anything
      //      above that is net yield.
      const userPrincipal = DEPOSIT_AMOUNT - (await armadaYieldVault.LOCKED_SHARES());
      const userAssetsNet = await armadaYieldVault.getUserAssets(user.address);
      const pendingFee = await armadaYieldVault.pendingProtocolFee();
      expect(userAssetsNet).to.be.gt(userPrincipal);
      expect(pendingFee).to.be.gt(0);

      // Treasury balance before
      const treasuryBefore = await armadaTreasury.getBalance(await usdc.getAddress());

      // Redeem all — settles the protocol's cut to treasury, pays user net amount.
      await armadaYieldVault.connect(user).redeem(
        shares,
        user.address,
        user.address
      );

      // Treasury received exactly the protocol's pending cut (the gross fee).
      const treasuryAfter = await armadaTreasury.getBalance(await usdc.getAddress());
      const feeReceived = treasuryAfter - treasuryBefore;
      expect(feeReceived).to.be.closeTo(pendingFee, ONE_USDC);

      // User received what their shares were worth: principal + net yield.
      const userFinal = await usdc.balanceOf(user.address);
      const expectedUserFinal = INITIAL_BALANCE - DEPOSIT_AMOUNT + userAssetsNet;
      expect(userFinal).to.be.closeTo(expectedUserFinal, ONE_USDC);
    });

    it("should allow redemption with no yield (no fee)", async function () {
      // Deposit
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Redeem immediately (no time passed, no yield)
      const shares = await armadaYieldVault.balanceOf(user.address);

      const treasuryBefore = await armadaTreasury.getBalance(await usdc.getAddress());

      await armadaYieldVault.connect(user).redeem(
        shares,
        user.address,
        user.address
      );

      // No fee should be charged
      const treasuryAfter = await armadaTreasury.getBalance(await usdc.getAddress());
      expect(treasuryAfter).to.equal(treasuryBefore);

      // User should get back what they deposited, less the share lock their first deposit paid for
      // (LOCKED_SHARES, #365), within a tiny rounding tolerance
      const lockedShares = await armadaYieldVault.LOCKED_SHARES();
      const userFinal = await usdc.balanceOf(user.address);
      expect(userFinal).to.be.closeTo(INITIAL_BALANCE - lockedShares, 10n);
    });
  });

  describe("ArmadaYieldAdapter", function () {
    it("should preview lend (shares for USDC amount)", async function () {
      const shares = await armadaYieldAdapter.previewLend(DEPOSIT_AMOUNT);
      expect(shares).to.be.closeTo(DEPOSIT_AMOUNT, 10n); // 1:1 at start
    });

    it("should preview redeem (USDC for shares amount)", async function () {
      const assets = await armadaYieldAdapter.previewRedeem(DEPOSIT_AMOUNT);
      expect(assets).to.be.closeTo(DEPOSIT_AMOUNT, 10n); // 1:1 at start
    });
  });

  describe("ArmadaTreasuryGov (yield fee sink)", function () {
    // WHY: After the treasury unification (#152/#154), yield fees flow into
    // ArmadaTreasuryGov via plain safeTransfer with no recordFee() call. This
    // test pins that the vault still transfers the expected 10% yield cut to
    // the treasury address — the outflow / governance side of TreasuryGov is
    // exercised in test/treasury_outflow.ts and the Foundry Treasury* suites.
    it("should receive yield fees", async function () {
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      await time.increase(ONE_YEAR);

      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).redeem(shares, user.address, user.address);

      const treasuryBalance = await armadaTreasury.getBalance(await usdc.getAddress());
      expect(treasuryBalance).to.be.gt(0);

      // Expect ~10% of 5% APY yield over 1 year on 1000 USDC = ~5 USDC.
      const expectedFee = (DEPOSIT_AMOUNT * BigInt(YIELD_BPS) * BigInt(YIELD_FEE_BPS)) / (10000n * 10000n);
      expect(treasuryBalance).to.be.closeTo(expectedFee, ONE_USDC);
    });
  });

  describe("MockAaveSpoke", function () {
    it("should track shares and assets correctly", async function () {
      // Approve spoke
      await usdc.connect(user).approve(
        await mockAaveSpoke.getAddress(),
        DEPOSIT_AMOUNT
      );

      // Supply
      await mockAaveSpoke.connect(user).supply(
        0, // reserveId
        DEPOSIT_AMOUNT,
        user.address
      );

      // Check balances (allow small rounding tolerance)
      const shares = await mockAaveSpoke.getUserSuppliedShares(0, user.address);
      expect(shares).to.be.closeTo(DEPOSIT_AMOUNT, 100n); // 1:1 at start

      const assets = await mockAaveSpoke.getUserSuppliedAssets(0, user.address);
      expect(assets).to.be.closeTo(DEPOSIT_AMOUNT, 100n);

      // Fast forward
      await time.increase(ONE_YEAR);

      // Assets should have grown
      const assetsAfter = await mockAaveSpoke.getUserSuppliedAssets(0, user.address);
      const expectedYield = (DEPOSIT_AMOUNT * BigInt(YIELD_BPS)) / 10000n;
      expect(assetsAfter).to.be.closeTo(DEPOSIT_AMOUNT + expectedYield, ONE_USDC);

      // Shares should remain the same
      const sharesAfter = await mockAaveSpoke.getUserSuppliedShares(0, user.address);
      expect(sharesAfter).to.equal(shares);
    });

    it("should mint yield tokens on withdrawal", async function () {
      // Approve and supply
      await usdc.connect(user).approve(
        await mockAaveSpoke.getAddress(),
        DEPOSIT_AMOUNT
      );
      await mockAaveSpoke.connect(user).supply(0, DEPOSIT_AMOUNT, user.address);

      // Fast forward
      await time.increase(ONE_YEAR);

      // Withdraw all
      await mockAaveSpoke.connect(user).withdraw(
        0,
        ethers.MaxUint256,
        user.address
      );

      // User should have more than initial
      const userUSDC = await usdc.balanceOf(user.address);
      const expectedYield = (DEPOSIT_AMOUNT * BigInt(YIELD_BPS)) / 10000n;
      expect(userUSDC).to.be.closeTo(INITIAL_BALANCE + expectedYield, ONE_USDC);
    });

    it("should support convertToAssets/convertToShares", async function () {
      // Before any deposits, 1:1 ratio (allow small rounding)
      const assetsFor1000 = await mockAaveSpoke.convertToAssets(0, ONE_USDC * 1000n);
      expect(assetsFor1000).to.be.closeTo(ONE_USDC * 1000n, 100n);

      // Deposit
      await usdc.connect(user).approve(
        await mockAaveSpoke.getAddress(),
        DEPOSIT_AMOUNT
      );
      await mockAaveSpoke.connect(user).supply(0, DEPOSIT_AMOUNT, user.address);

      // Fast forward
      await time.increase(ONE_YEAR);

      // Now shares are worth more
      const assetsAfterYear = await mockAaveSpoke.convertToAssets(0, DEPOSIT_AMOUNT);
      expect(assetsAfterYear).to.be.gt(DEPOSIT_AMOUNT);

      // And same assets require fewer shares
      const sharesNeeded = await mockAaveSpoke.convertToShares(0, DEPOSIT_AMOUNT);
      expect(sharesNeeded).to.be.lt(DEPOSIT_AMOUNT);
    });
  });

  describe("Full Flow", function () {
    it("should complete full deposit → yield → redeem flow", async function () {
      console.log("\n=== Full Yield Flow Test ===\n");

      // Step 1: User deposits USDC to vault
      console.log("1. Depositing 1000 USDC to ArmadaYieldVault...");
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      const sharesReceived = await armadaYieldVault.balanceOf(user.address);
      console.log(`   Received ${ethers.formatUnits(sharesReceived, 6)} ayUSDC shares`);

      // Step 2: Time passes, yield accrues
      console.log("\n2. Fast-forwarding 1 year...");
      await time.increase(ONE_YEAR);

      const assetsAfterYear = await armadaYieldVault.getUserAssets(user.address);
      const yieldAccrued = assetsAfterYear - (DEPOSIT_AMOUNT - (await armadaYieldVault.LOCKED_SHARES()));
      console.log(`   Assets after 1 year: ${ethers.formatUnits(assetsAfterYear, 6)} USDC`);
      console.log(`   Yield accrued: ${ethers.formatUnits(yieldAccrued, 6)} USDC`);

      // Step 3: User redeems with yield fee
      console.log("\n3. Redeeming all shares...");
      const shares = await armadaYieldVault.balanceOf(user.address);

      const treasuryBefore = await armadaTreasury.getBalance(await usdc.getAddress());
      await armadaYieldVault.connect(user).redeem(shares, user.address, user.address);
      const treasuryAfter = await armadaTreasury.getBalance(await usdc.getAddress());

      const feeCollected = treasuryAfter - treasuryBefore;
      const userFinal = await usdc.balanceOf(user.address);

      console.log(`   Fee collected (10% of yield): ${ethers.formatUnits(feeCollected, 6)} USDC`);
      console.log(`   User final balance: ${ethers.formatUnits(userFinal, 6)} USDC`);
      console.log(`   Net gain: ${ethers.formatUnits(userFinal - INITIAL_BALANCE, 6)} USDC`);

      // Verify
      expect(userFinal).to.be.gt(INITIAL_BALANCE);
      expect(feeCollected).to.be.gt(0);

      console.log("\n=== Flow Complete ===\n");
    });
  });
});
