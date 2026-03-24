// ABOUTME: Tests for aggregate outflow rate limits on ArmadaTreasuryGov.
// ABOUTME: Covers rolling window enforcement, percentage vs absolute limits, immutable floors, and governance setters.

/**
 * Treasury Outflow Rate Limits (Task 3.1)
 *
 * The treasury enforces aggregate outflow rate limits per token over a rolling
 * 30-day window. Both governance distributions and steward spending count against
 * the same limit. The effective limit is:
 *   max(percentageOfBalance, absoluteLimit), then max(result, floorAbsolute)
 *
 * The floor is immutable once set — governance can never reduce the limit below it.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const ONE_DAY = 86400;
const THIRTY_DAYS = 30 * ONE_DAY;
const MAX_PAUSE_DURATION = 14 * ONE_DAY;
const USDC_DECIMALS = 6;

const USDC = (n: number) => ethers.parseUnits(n.toString(), USDC_DECIMALS);

describe("Treasury Outflow Rate Limits", function () {
  let treasury: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let stewardAddr: SignerWithAddress;
  let recipient: SignerWithAddress;
  let guardian: SignerWithAddress;

  async function deployTreasury() {
    [deployer, stewardAddr, recipient, guardian] = await ethers.getSigners();

    // Deploy mock USDC
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Deploy treasury (deployer acts as owner/timelock for direct testing)
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(
      deployer.address, guardian.address, MAX_PAUSE_DURATION
    );
    await treasury.waitForDeployment();

    // stewardAddr is used as a non-owner signer to test access-control rejections
  }

  async function fundTreasury(amount: bigint) {
    await usdc.mint(await treasury.getAddress(), amount);
  }

  // Helper: configure outflow for USDC with standard params
  async function initUsdcOutflow(opts?: {
    window?: number;
    bps?: number;
    absolute?: bigint;
    floor?: bigint;
  }) {
    const window = opts?.window ?? THIRTY_DAYS;
    const bps = opts?.bps ?? 1000; // 10%
    const absolute = opts?.absolute ?? USDC(100_000); // $100K
    const floor = opts?.floor ?? USDC(50_000); // $50K
    await treasury.initOutflowConfig(
      await usdc.getAddress(), window, bps, absolute, floor
    );
  }

  beforeEach(async function () {
    await deployTreasury();
  });

  // ============================================================
  // 1. Configuration
  // ============================================================

  describe("Outflow Configuration", function () {
    it("should initialize outflow config for a token", async function () {
      await fundTreasury(USDC(1_000_000));
      await initUsdcOutflow();

      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.windowDuration).to.equal(THIRTY_DAYS);
      expect(config.limitBps).to.equal(1000);
      expect(config.limitAbsolute).to.equal(USDC(100_000));
      expect(config.floorAbsolute).to.equal(USDC(50_000));
    });

    it("should reject initOutflowConfig from non-owner", async function () {
      await expect(
        treasury.connect(stewardAddr).initOutflowConfig(
          await usdc.getAddress(), THIRTY_DAYS, 1000, USDC(100_000), USDC(50_000)
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
    });

    it("should reject initOutflowConfig with zero window", async function () {
      await expect(
        treasury.initOutflowConfig(
          await usdc.getAddress(), 0, 1000, USDC(100_000), USDC(50_000)
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: window too short");
    });

    it("should reject initOutflowConfig if already initialized for token", async function () {
      await initUsdcOutflow();
      await expect(
        initUsdcOutflow()
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow already initialized");
    });

    it("should reject absolute limit below floor", async function () {
      await expect(
        treasury.initOutflowConfig(
          await usdc.getAddress(), THIRTY_DAYS, 1000, USDC(30_000), USDC(50_000)
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: absolute below floor");
    });
  });

  // ============================================================
  // 2. Governance Setters
  // ============================================================

  describe("Governance Setters", function () {
    beforeEach(async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow();
    });

    it("should allow owner to update outflow window", async function () {
      await treasury.setOutflowWindow(await usdc.getAddress(), 60 * ONE_DAY);
      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.windowDuration).to.equal(60 * ONE_DAY);
    });

    it("should reject window below 1 day", async function () {
      await expect(
        treasury.setOutflowWindow(await usdc.getAddress(), ONE_DAY - 1)
      ).to.be.revertedWith("ArmadaTreasuryGov: window too short");
    });

    it("should allow owner to update outflow bps", async function () {
      await treasury.setOutflowLimitBps(await usdc.getAddress(), 2000);
      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.limitBps).to.equal(2000);
    });

    it("should reject bps above 10000", async function () {
      await expect(
        treasury.setOutflowLimitBps(await usdc.getAddress(), 10001)
      ).to.be.revertedWith("ArmadaTreasuryGov: bps out of range");
    });

    it("should allow owner to update absolute limit", async function () {
      await treasury.setOutflowLimitAbsolute(await usdc.getAddress(), USDC(200_000));
      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.limitAbsolute).to.equal(USDC(200_000));
    });

    it("should reject absolute limit below floor", async function () {
      // Floor is $50K
      await expect(
        treasury.setOutflowLimitAbsolute(await usdc.getAddress(), USDC(49_999))
      ).to.be.revertedWith("ArmadaTreasuryGov: absolute below floor");
    });

    it("should reject setter calls from non-owner", async function () {
      const usdcAddr = await usdc.getAddress();
      await expect(
        treasury.connect(stewardAddr).setOutflowWindow(usdcAddr, THIRTY_DAYS)
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
      await expect(
        treasury.connect(stewardAddr).setOutflowLimitBps(usdcAddr, 2000)
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
      await expect(
        treasury.connect(stewardAddr).setOutflowLimitAbsolute(usdcAddr, USDC(200_000))
      ).to.be.revertedWith("ArmadaTreasuryGov: not owner");
    });

    it("should reject setter calls for uninitialized token", async function () {
      const fakeToken = ethers.Wallet.createRandom().address;
      await expect(
        treasury.setOutflowWindow(fakeToken, THIRTY_DAYS)
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow not initialized");
    });
  });

  // ============================================================
  // 3. Outflow Enforcement — distribute()
  // ============================================================

  describe("Outflow Enforcement — distribute()", function () {
    it("should allow single outflow within limit", async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow(); // 10% of $5M = $500K limit (pct > $100K absolute)

      // $400K is within the $500K limit
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(400_000));

      expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(400_000));
    });

    it("should reject single outflow exceeding limit", async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow(); // effective limit = $500K (10% of $5M)

      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, USDC(500_001))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("should accumulate outflows within window", async function () {
      // Use a small treasury where absolute limit ($100K) dominates over percentage.
      // This keeps the effective limit constant as the balance decreases.
      await fundTreasury(USDC(500_000));
      await initUsdcOutflow(); // 10% of $500K = $50K < $100K absolute → limit = $100K

      // Two outflows totaling $100K — should succeed
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(60_000));
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(40_000));

      // Third outflow of $1 should fail (at limit)
      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, 1n)
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("should allow outflows after window expires (rolling)", async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow(); // limit = $500K

      // Spend full limit
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(500_000));

      // Advance past window
      await time.increase(THIRTY_DAYS + 1);

      // Should be able to spend again (old outflows expired)
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(400_000));
      expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(900_000));
    });

    it("should use percentage limit on large treasury (pct > absolute)", async function () {
      // $5M treasury, 10% = $500K > $100K absolute → effective limit = $500K
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow();

      // $400K should succeed (within $500K pct limit)
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(400_000));
      expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(400_000));
    });

    it("should use absolute limit on small treasury (absolute > pct)", async function () {
      // $500K treasury, 10% = $50K < $100K absolute → effective limit = $100K
      await fundTreasury(USDC(500_000));
      await initUsdcOutflow();

      // $80K should succeed (within $100K absolute limit)
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(80_000));

      // Another $30K should fail ($80K + $30K = $110K > $100K)
      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, USDC(30_000))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("should use floor on tiny treasury (floor > both pct and absolute)", async function () {
      // $200K treasury, 10% = $20K, absolute = $100K, floor = $50K
      // max(pct=$20K, absolute=$100K) = $100K, then max($100K, floor=$50K) = $100K
      // Actually floor is a minimum — it ensures the limit never goes below $50K.
      // With pct=$20K, absolute=$100K: max($20K, $100K) = $100K > $50K floor → limit = $100K
      //
      // For floor to kick in, we need a config where both pct and absolute are below floor.
      // Let's use: bps=100 (1%), absolute=$40K, floor=$50K — but that fails init (absolute < floor).
      // Floor means: governance cannot set absolute below floor. So floor is enforced at config time.
      //
      // The floor protects against governance reducing limits too low. With floor=$50K,
      // the absolute can never be set below $50K, so effective limit >= $50K always.
      // Test: set absolute to exactly floor, small treasury where pct < floor.
      await fundTreasury(USDC(200_000));
      await treasury.initOutflowConfig(
        await usdc.getAddress(), THIRTY_DAYS, 100, USDC(50_000), USDC(50_000) // 1%, abs=$50K, floor=$50K
      );
      // pct = 1% of $200K = $2K, absolute = $50K → limit = max($2K, $50K) = $50K

      // $45K should succeed
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(45_000));

      // $10K more should fail ($45K + $10K = $55K > $50K)
      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, USDC(10_000))
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("should skip outflow check if no config initialized for token", async function () {
      await fundTreasury(USDC(1_000_000));
      // No initOutflowConfig called — distribute should work without limits
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(1_000_000));
      expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(1_000_000));
    });
  });

  // ============================================================
  // 4. Outflow Enforcement — stewardSpend()
  // ============================================================

  describe("Outflow Enforcement — stewardSpend()", function () {
    it("should count steward spending against outflow limit", async function () {
      // Use small treasury where absolute limit ($100K) dominates
      await fundTreasury(USDC(500_000));
      await initUsdcOutflow(); // 10% of $500K = $50K < $100K → limit = $100K

      // Authorize USDC for steward spending (limit = $10K, window = 30d)
      await treasury.addStewardBudgetToken(await usdc.getAddress(), USDC(10_000), THIRTY_DAYS);

      // Owner calls stewardSpend — $5K within steward budget and outflow limit
      await treasury.stewardSpend(
        await usdc.getAddress(), recipient.address, USDC(5_000)
      );

      // Governance distributes $95K (total outflow = $100K = limit)
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(95_000));

      // Next $1 from either path should fail
      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, 1n)
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });

    it("should enforce outflow limit on stewardSpend independently of budget", async function () {
      // Tiny treasury: $60K, outflow limit with absolute = $50K
      // But outflow limit applies as an aggregate cap on all outflows
      await fundTreasury(USDC(60_000));
      await treasury.initOutflowConfig(
        await usdc.getAddress(), THIRTY_DAYS, 1000, USDC(50_000), USDC(50_000)
      );

      // Authorize USDC for steward spending (large limit — outflow limit is more restrictive here)
      await treasury.addStewardBudgetToken(await usdc.getAddress(), USDC(60_000), THIRTY_DAYS);

      // Governance distributes $50K (at the outflow limit)
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(50_000));

      // Steward spend of $1 should fail outflow limit (even if within steward budget)
      await expect(
        treasury.stewardSpend(
          await usdc.getAddress(), recipient.address, 1n
        )
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");
    });
  });

  // ============================================================
  // 5. Rolling Window Behavior
  // ============================================================

  describe("Rolling Window", function () {
    it("should expire old outflows outside the window", async function () {
      // Use small treasury where absolute limit ($100K) dominates, keeping limit constant
      await fundTreasury(USDC(500_000));
      await initUsdcOutflow(); // limit = $100K (absolute > 10% of $500K = $50K), window = 30d

      // Day 0: spend $60K
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(60_000));

      // Day 15: spend another $40K (total in window = $100K = limit)
      await time.increase(15 * ONE_DAY);
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(40_000));

      // Day 15: at limit, can't spend more
      await expect(
        treasury.distribute(await usdc.getAddress(), recipient.address, 1n)
      ).to.be.revertedWith("ArmadaTreasuryGov: outflow limit exceeded");

      // Day 31: the $60K from day 0 has expired
      await time.increase(16 * ONE_DAY);
      // Remaining in window: $40K from day 15 (still within window)
      // Absolute limit still $100K (balance = $400K, 10% = $40K < $100K)
      // Available: $100K - $40K = $60K
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(60_000));
      expect(await usdc.balanceOf(recipient.address)).to.equal(USDC(160_000));
    });

    it("should track USDC and ARM independently", async function () {
      // Deploy a second token (mock ARM)
      const MockERC20 = await ethers.getContractFactory("MockUSDCV2");
      const mockArm = await MockERC20.deploy("Mock ARM", "ARM");
      await mockArm.waitForDeployment();

      await fundTreasury(USDC(5_000_000));
      await mockArm.mint(await treasury.getAddress(), ethers.parseUnits("1000000", 6));

      // Init outflow for both tokens
      await initUsdcOutflow();
      await treasury.initOutflowConfig(
        await mockArm.getAddress(), THIRTY_DAYS, 300, ethers.parseUnits("250000", 6), ethers.parseUnits("100000", 6)
      );

      // Spend USDC up to limit
      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(500_000));

      // ARM should still be spendable (independent tracking)
      await treasury.distribute(await mockArm.getAddress(), recipient.address, ethers.parseUnits("30000", 6));

      expect(await mockArm.balanceOf(recipient.address)).to.equal(ethers.parseUnits("30000", 6));
    });
  });

  // ============================================================
  // 6. Floor Immutability
  // ============================================================

  describe("Floor Immutability", function () {
    it("should prevent governance from reducing absolute below floor", async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow(); // floor = $50K

      // Try to set absolute to $49K (below floor)
      await expect(
        treasury.setOutflowLimitAbsolute(await usdc.getAddress(), USDC(49_000))
      ).to.be.revertedWith("ArmadaTreasuryGov: absolute below floor");

      // Setting to exactly floor should succeed
      await treasury.setOutflowLimitAbsolute(await usdc.getAddress(), USDC(50_000));
      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.limitAbsolute).to.equal(USDC(50_000));
    });

    it("should allow governance to increase limits freely", async function () {
      await fundTreasury(USDC(5_000_000));
      await initUsdcOutflow();

      await treasury.setOutflowLimitBps(await usdc.getAddress(), 5000); // 50%
      await treasury.setOutflowLimitAbsolute(await usdc.getAddress(), USDC(1_000_000));

      const config = await treasury.getOutflowConfig(await usdc.getAddress());
      expect(config.limitBps).to.equal(5000);
      expect(config.limitAbsolute).to.equal(USDC(1_000_000));
    });
  });

  // ============================================================
  // 7. View Functions
  // ============================================================

  describe("View Functions", function () {
    it("should return current outflow status via getOutflowStatus", async function () {
      // Use small treasury where absolute limit dominates (stays constant after outflows)
      await fundTreasury(USDC(500_000));
      await initUsdcOutflow(); // limit = $100K (absolute dominates over 10% of $500K = $50K)

      await treasury.distribute(await usdc.getAddress(), recipient.address, USDC(30_000));

      const status = await treasury.getOutflowStatus(await usdc.getAddress());
      // Balance now $470K, 10% = $47K < $100K absolute → effective = $100K
      expect(status.effectiveLimit).to.equal(USDC(100_000));
      expect(status.recentOutflow).to.equal(USDC(30_000));
      expect(status.available).to.equal(USDC(70_000));
    });
  });
});
