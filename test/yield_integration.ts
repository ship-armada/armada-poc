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
  let relayer: SignerWithAddress;

  // Constants
  const USDC_DECIMALS = 6;
  const ONE_USDC = ethers.parseUnits("1", USDC_DECIMALS);
  const INITIAL_BALANCE = ethers.parseUnits("10000", USDC_DECIMALS); // 10,000 USDC
  const DEPOSIT_AMOUNT = ethers.parseUnits("1000", USDC_DECIMALS); // 1,000 USDC
  const YIELD_BPS = 500; // 5% APY
  const YIELD_FEE_BPS = 1000; // 10% fee
  const ONE_YEAR = 365 * 24 * 60 * 60;

  beforeEach(async function () {
    [deployer, user, relayer] = await ethers.getSigners();

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

    // 5. Deploy ArmadaTreasury
    const ArmadaTreasury = await ethers.getContractFactory("ArmadaTreasury");
    armadaTreasury = await ArmadaTreasury.deploy();
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

    // 7. Deploy ArmadaYieldAdapter
    const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
    armadaYieldAdapter = await ArmadaYieldAdapter.deploy(
      await usdc.getAddress(),
      await armadaYieldVault.getAddress()
    );
    await armadaYieldAdapter.waitForDeployment();

    // 8. Configure vault adapter
    await armadaYieldVault.setAdapter(await armadaYieldAdapter.getAddress());

    // 9. Add relayer
    await armadaYieldAdapter.setRelayer(relayer.address, true);

    // 10. Mint USDC to user
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

      // Check balances (allow small rounding tolerance)
      const shares = await armadaYieldVault.balanceOf(user.address);
      expect(shares).to.be.closeTo(DEPOSIT_AMOUNT, 10n); // 1:1 for first deposit

      const userUSDC = await usdc.balanceOf(user.address);
      expect(userUSDC).to.be.closeTo(INITIAL_BALANCE - DEPOSIT_AMOUNT, 10n);

      // Check vault state
      const totalAssets = await armadaYieldVault.totalAssets();
      expect(totalAssets).to.be.closeTo(DEPOSIT_AMOUNT, 10n);

      const totalPrincipal = await armadaYieldVault.totalPrincipal();
      expect(totalPrincipal).to.equal(DEPOSIT_AMOUNT);
    });

    it("should accrue yield over time", async function () {
      // Deposit
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Check initial assets (allow small rounding tolerance)
      const initialAssets = await armadaYieldVault.getUserAssets(user.address);
      expect(initialAssets).to.be.closeTo(DEPOSIT_AMOUNT, 10n);

      // Fast forward 1 year
      await time.increase(ONE_YEAR);

      // Check assets after yield
      const assetsAfterYear = await armadaYieldVault.getUserAssets(user.address);

      // Expected: ~1050 USDC (5% APY)
      const expectedYield = (DEPOSIT_AMOUNT * BigInt(YIELD_BPS)) / 10000n;
      const expectedTotal = DEPOSIT_AMOUNT + expectedYield;

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

      // Get expected yield (before fee)
      const userYield = await armadaYieldVault.getUserYield(user.address);
      expect(userYield).to.be.gt(0);

      // Treasury balance before
      const treasuryBefore = await armadaTreasury.getBalance(await usdc.getAddress());

      // Redeem all
      await armadaYieldVault.connect(user).redeem(
        shares,
        user.address,
        user.address
      );

      // Check treasury received fee
      const treasuryAfter = await armadaTreasury.getBalance(await usdc.getAddress());
      const feeReceived = treasuryAfter - treasuryBefore;

      // Fee should be ~10% of yield
      const expectedFee = (userYield * BigInt(YIELD_FEE_BPS)) / 10000n;
      expect(feeReceived).to.be.closeTo(expectedFee, ONE_USDC);

      // User should receive principal + yield - fee
      const userFinal = await usdc.balanceOf(user.address);
      const expectedUserFinal = INITIAL_BALANCE + userYield - feeReceived;
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

      // User should get back approximately what they deposited (tiny rounding tolerance)
      const userFinal = await usdc.balanceOf(user.address);
      expect(userFinal).to.be.closeTo(INITIAL_BALANCE, 10n);
    });
  });

  describe("ArmadaYieldAdapter", function () {
    // CCTP contracts for cross-chain tests
    let mockMessageTransmitter: any;
    let mockTokenMessenger: any;

    // Deploy CCTP contracts for tests that need them
    async function deployCCTP() {
      // Deploy MessageTransmitter
      const MockMessageTransmitterV2 = await ethers.getContractFactory("MockMessageTransmitterV2");
      mockMessageTransmitter = await MockMessageTransmitterV2.deploy(0, deployer.address); // domain 0, relayer = deployer
      await mockMessageTransmitter.waitForDeployment();

      // Deploy TokenMessenger
      const MockTokenMessengerV2 = await ethers.getContractFactory("MockTokenMessengerV2");
      mockTokenMessenger = await MockTokenMessengerV2.deploy(
        await mockMessageTransmitter.getAddress(),
        await usdc.getAddress(),
        0 // localDomain
      );
      await mockTokenMessenger.waitForDeployment();

      // Link them together
      await mockMessageTransmitter.setTokenMessenger(await mockTokenMessenger.getAddress());

      // Add TokenMessenger as USDC minter (for receiving messages)
      await usdc.addMinter(await mockTokenMessenger.getAddress());

      // Configure adapter with TokenMessenger
      await armadaYieldAdapter.setTokenMessenger(await mockTokenMessenger.getAddress());
    }

    it("should allow lend via adapter (POC mode)", async function () {
      // Approve adapter
      await usdc.connect(user).approve(
        await armadaYieldAdapter.getAddress(),
        DEPOSIT_AMOUNT
      );

      // Lend
      const tx = await armadaYieldAdapter.connect(user).lend(DEPOSIT_AMOUNT);
      await tx.wait();

      // User should have vault shares
      const shares = await armadaYieldVault.balanceOf(user.address);
      expect(shares).to.equal(DEPOSIT_AMOUNT);

      // User should have spent USDC
      const userUSDC = await usdc.balanceOf(user.address);
      expect(userUSDC).to.equal(INITIAL_BALANCE - DEPOSIT_AMOUNT);
    });

    it("should allow redeem via adapter (POC mode)", async function () {
      // First, lend via adapter
      await usdc.connect(user).approve(
        await armadaYieldAdapter.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldAdapter.connect(user).lend(DEPOSIT_AMOUNT);

      // Fast forward 1 year
      await time.increase(ONE_YEAR);

      // Approve adapter to take shares
      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).approve(
        await armadaYieldAdapter.getAddress(),
        shares
      );

      // Redeem via adapter
      await armadaYieldAdapter.connect(user).redeemShares(shares);

      // User should have no shares
      const sharesAfter = await armadaYieldVault.balanceOf(user.address);
      expect(sharesAfter).to.equal(0);

      // User should have more USDC than initial (yield - fee)
      const userUSDC = await usdc.balanceOf(user.address);
      expect(userUSDC).to.be.gt(INITIAL_BALANCE);
    });

    it("should allow relayer to execute private operations", async function () {
      // Mint USDC to adapter (simulating unshield)
      await usdc.mint(await armadaYieldAdapter.getAddress(), DEPOSIT_AMOUNT);

      // Relayer executes lendPrivate
      await armadaYieldAdapter.connect(relayer).lendPrivate(
        DEPOSIT_AMOUNT,
        user.address
      );

      // User should have shares
      const shares = await armadaYieldVault.balanceOf(user.address);
      expect(shares).to.equal(DEPOSIT_AMOUNT);
    });

    it("should allow redeemAndUnshield (pay directly to recipient)", async function () {
      // First, lend via adapter
      await usdc.connect(user).approve(
        await armadaYieldAdapter.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldAdapter.connect(user).lend(DEPOSIT_AMOUNT);

      // Fast forward 1 year for yield
      await time.increase(ONE_YEAR);

      // Transfer shares to adapter (simulating unshield)
      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).transfer(
        await armadaYieldAdapter.getAddress(),
        shares
      );

      // Relayer calls redeemAndUnshield to send directly to recipient
      const recipient = relayer.address; // Use relayer as recipient for this test
      const recipientBefore = await usdc.balanceOf(recipient);

      await armadaYieldAdapter.connect(relayer).redeemAndUnshield(shares, recipient);

      // Recipient should have received USDC
      const recipientAfter = await usdc.balanceOf(recipient);
      expect(recipientAfter).to.be.gt(recipientBefore);

      // Adapter has no cost basis (shares were transferred, not deposited through it),
      // so the vault treats the full gross amount as yield and charges 10% fee.
      // Expected: ~1050 gross * 0.9 = ~945
      const received = recipientAfter - recipientBefore;
      const grossExpected = DEPOSIT_AMOUNT + (DEPOSIT_AMOUNT * BigInt(YIELD_BPS)) / 10000n;
      const netExpected = grossExpected - (grossExpected * BigInt(YIELD_FEE_BPS)) / 10000n;
      expect(received).to.be.closeTo(netExpected, ONE_USDC);
    });

    it("should allow redeemAndUnshieldCCTP for cross-chain yield redemption", async function () {
      // Deploy CCTP contracts
      await deployCCTP();

      // First, lend via adapter
      await usdc.connect(user).approve(
        await armadaYieldAdapter.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldAdapter.connect(user).lend(DEPOSIT_AMOUNT);

      // Fast forward 1 year for yield
      await time.increase(ONE_YEAR);

      // Get shares
      const shares = await armadaYieldVault.balanceOf(user.address);

      // Transfer shares to adapter (simulating unshield of ayUSDC)
      await armadaYieldVault.connect(user).transfer(
        await armadaYieldAdapter.getAddress(),
        shares
      );

      // Total supply of USDC before burn
      const totalSupplyBefore = await usdc.totalSupply();

      // Relayer calls redeemAndUnshieldCCTP to bridge USDC to another chain
      const destinationDomain = 1; // Simulate destination chain domain
      const finalRecipient = user.address;
      const destinationCaller = ethers.ZeroHash; // Anyone can call receiveMessage

      const tx = await armadaYieldAdapter.connect(relayer).redeemAndUnshieldCCTP(
        shares,
        destinationDomain,
        finalRecipient,
        destinationCaller
      );
      const receipt = await tx.wait();

      // Check event was emitted
      const event = receipt.logs.find(
        (log: any) => log.fragment?.name === "RedeemAndUnshieldCCTP"
      );
      expect(event).to.not.be.undefined;

      // USDC should have been burned (total supply decreased)
      const totalSupplyAfter = await usdc.totalSupply();
      expect(totalSupplyAfter).to.be.lt(totalSupplyBefore);

      // Adapter has no cost basis, so full gross treated as yield with 10% fee.
      // The burned amount is the net assets after fee (fee goes to treasury, not burned).
      // Additionally, MockAaveSpoke mints yield tokens which affects total supply accounting.
      const burnedAmount = totalSupplyBefore - totalSupplyAfter;
      expect(burnedAmount).to.be.gt(0); // USDC was burned for cross-chain transfer

      // Adapter should have no remaining USDC or shares
      const adapterUsdc = await usdc.balanceOf(await armadaYieldAdapter.getAddress());
      const adapterShares = await armadaYieldVault.balanceOf(await armadaYieldAdapter.getAddress());
      expect(adapterUsdc).to.equal(0);
      expect(adapterShares).to.equal(0);

      console.log(`   CCTP burn completed: ${ethers.formatUnits(burnedAmount, 6)} USDC burned for cross-chain transfer`);
    });

    it("should reject redeemAndUnshieldCCTP without TokenMessenger configured", async function () {
      // Deploy a fresh adapter without CCTP configuration
      const ArmadaYieldAdapter = await ethers.getContractFactory("ArmadaYieldAdapter");
      const freshAdapter = await ArmadaYieldAdapter.deploy(
        await usdc.getAddress(),
        await armadaYieldVault.getAddress()
      );
      await freshAdapter.waitForDeployment();
      await freshAdapter.setRelayer(relayer.address, true);

      // Try to call redeemAndUnshieldCCTP - should fail
      await expect(
        freshAdapter.connect(relayer).redeemAndUnshieldCCTP(
          DEPOSIT_AMOUNT,
          1, // destinationDomain
          user.address,
          ethers.ZeroHash
        )
      ).to.be.revertedWith("ArmadaYieldAdapter: no tokenMessenger");
    });

    it("should reject redeemAndUnshieldCCTP with zero shares", async function () {
      await deployCCTP();

      await expect(
        armadaYieldAdapter.connect(relayer).redeemAndUnshieldCCTP(
          0, // zero shares
          1,
          user.address,
          ethers.ZeroHash
        )
      ).to.be.revertedWith("ArmadaYieldAdapter: zero shares");
    });

    it("should reject redeemAndUnshieldCCTP with zero recipient", async function () {
      await deployCCTP();

      await expect(
        armadaYieldAdapter.connect(relayer).redeemAndUnshieldCCTP(
          DEPOSIT_AMOUNT,
          1,
          ethers.ZeroAddress, // zero recipient
          ethers.ZeroHash
        )
      ).to.be.revertedWith("ArmadaYieldAdapter: zero recipient");
    });
  });

  describe("ArmadaTreasury", function () {
    it("should receive and track yield fees", async function () {
      // Deposit
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);

      // Fast forward 1 year
      await time.increase(ONE_YEAR);

      // Redeem to trigger fee
      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).redeem(shares, user.address, user.address);

      // Treasury should have received fees
      const treasuryBalance = await armadaTreasury.getBalance(await usdc.getAddress());
      expect(treasuryBalance).to.be.gt(0);

      // Should be ~10% of yield (5 USDC from 50 USDC yield)
      const expectedFee = (DEPOSIT_AMOUNT * BigInt(YIELD_BPS) * BigInt(YIELD_FEE_BPS)) / (10000n * 10000n);
      expect(treasuryBalance).to.be.closeTo(expectedFee, ONE_USDC);
    });

    it("should allow owner to withdraw fees", async function () {
      // First, get some fees into treasury
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);
      await time.increase(ONE_YEAR);
      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).redeem(shares, user.address, user.address);

      // Check treasury has balance
      const treasuryBalance = await armadaTreasury.getBalance(await usdc.getAddress());
      expect(treasuryBalance).to.be.gt(0);

      // Owner withdraws fees
      const deployerBefore = await usdc.balanceOf(deployer.address);
      await armadaTreasury.withdraw(
        await usdc.getAddress(),
        deployer.address,
        treasuryBalance
      );
      const deployerAfter = await usdc.balanceOf(deployer.address);

      // Deployer should have received the fees
      expect(deployerAfter - deployerBefore).to.equal(treasuryBalance);

      // Treasury should be empty
      const treasuryAfter = await armadaTreasury.getBalance(await usdc.getAddress());
      expect(treasuryAfter).to.equal(0);
    });

    it("should reject withdrawal from non-owner", async function () {
      // Get some fees into treasury
      await usdc.connect(user).approve(
        await armadaYieldVault.getAddress(),
        DEPOSIT_AMOUNT
      );
      await armadaYieldVault.connect(user).deposit(DEPOSIT_AMOUNT, user.address);
      await time.increase(ONE_YEAR);
      const shares = await armadaYieldVault.balanceOf(user.address);
      await armadaYieldVault.connect(user).redeem(shares, user.address, user.address);

      // Non-owner tries to withdraw
      const treasuryBalance = await armadaTreasury.getBalance(await usdc.getAddress());
      await expect(
        armadaTreasury.connect(user).withdraw(
          await usdc.getAddress(),
          user.address,
          treasuryBalance
        )
      ).to.be.revertedWith("ArmadaTreasury: not owner");
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
      const yieldAccrued = await armadaYieldVault.getUserYield(user.address);
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
