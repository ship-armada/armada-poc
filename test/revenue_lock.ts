// ABOUTME: Hardhat integration tests for RevenueLock — full stack with real ArmadaToken and RevenueCounter.
// ABOUTME: Covers milestone-based release lifecycle, atomic delegation, multi-beneficiary independence, and view accuracy.

/**
 * RevenueLock Integration Tests
 *
 * RevenueLock is an immutable contract that holds team and airdrop ARM tokens
 * and releases them to beneficiaries as cumulative protocol revenue milestones
 * are reached. It reads RevenueCounter.recognizedRevenueUsd() and uses a step
 * function to determine the unlock percentage.
 *
 * These tests deploy the full governance stack (ArmadaToken, TimelockController,
 * RevenueCounter proxy) and verify end-to-end release mechanics.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RevenueLock", function () {
  let revenueLock: any;
  let armToken: any;
  let revenueCounter: any;
  let mockFeeCollector: any;
  let timelock: any;

  let deployer: SignerWithAddress;
  let beneficiaryA: SignerWithAddress;
  let beneficiaryB: SignerWithAddress;
  let beneficiaryC: SignerWithAddress;
  let delegateeX: SignerWithAddress;
  let delegateeY: SignerWithAddress;
  let nonBeneficiary: SignerWithAddress;

  const TOTAL_SUPPLY = ethers.parseUnits("12000000", 18);
  const ALLOC_A = ethers.parseUnits("1200000", 18);
  const ALLOC_B = ethers.parseUnits("800000", 18);
  const ALLOC_C = ethers.parseUnits("400000", 18);
  const TOTAL_LOCK = ALLOC_A + ALLOC_B + ALLOC_C; // 2,400,000 ARM

  // Revenue thresholds in 18-decimal USD
  const REV_10K = ethers.parseUnits("10000", 18);
  const REV_50K = ethers.parseUnits("50000", 18);
  const REV_100K = ethers.parseUnits("100000", 18);
  const REV_250K = ethers.parseUnits("250000", 18);
  const REV_500K = ethers.parseUnits("500000", 18);
  const REV_1M = ethers.parseUnits("1000000", 18);

  async function deployAll() {
    [deployer, beneficiaryA, beneficiaryB, beneficiaryC, delegateeX, delegateeY, nonBeneficiary] =
      await ethers.getSigners();

    // 1. Deploy TimelockController
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelock = await TimelockController.deploy(
      2 * 24 * 60 * 60, // 2 days
      [],
      [],
      deployer.address
    );
    await timelock.waitForDeployment();

    // 2. Deploy ArmadaToken
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, await timelock.getAddress());
    await armToken.waitForDeployment();

    // 3. Deploy RevenueCounter behind UUPS proxy
    const MockFeeCollector = await ethers.getContractFactory("MockFeeCollector");
    mockFeeCollector = await MockFeeCollector.deploy();
    await mockFeeCollector.waitForDeployment();

    const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
    const rcImpl = await RevenueCounter.deploy();
    await rcImpl.waitForDeployment();

    const initData = RevenueCounter.interface.encodeFunctionData("initialize", [deployer.address]);
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const rcProxy = await ERC1967Proxy.deploy(await rcImpl.getAddress(), initData);
    await rcProxy.waitForDeployment();
    revenueCounter = RevenueCounter.attach(await rcProxy.getAddress());

    // Set fee collector on revenue counter
    await revenueCounter.setFeeCollector(await mockFeeCollector.getAddress());

    // 4. Deploy RevenueLock
    const RevenueLock = await ethers.getContractFactory("RevenueLock");
    revenueLock = await RevenueLock.deploy(
      await armToken.getAddress(),
      await revenueCounter.getAddress(),
      [beneficiaryA.address, beneficiaryB.address, beneficiaryC.address],
      [ALLOC_A, ALLOC_B, ALLOC_C]
    );
    await revenueLock.waitForDeployment();

    // 5. Configure ArmadaToken
    // Whitelist: deployer, revenueLock, all beneficiaries
    await armToken.initWhitelist([
      deployer.address,
      await revenueLock.getAddress(),
      beneficiaryA.address,
      beneficiaryB.address,
      beneficiaryC.address,
    ]);

    // Authorize RevenueLock for delegateOnBehalf
    await armToken.initAuthorizedDelegators([await revenueLock.getAddress()]);

    // 6. Fund RevenueLock with ARM
    await armToken.transfer(await revenueLock.getAddress(), TOTAL_LOCK);

    // Mine a block so voting checkpoints work
    await mine(1);
  }

  beforeEach(async function () {
    await deployAll();
  });

  // ============================================================
  // 1. Setup Verification
  // ============================================================

  describe("Setup", function () {
    it("should have correct allocations", async function () {
      expect(await revenueLock.allocation(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await revenueLock.allocation(beneficiaryB.address)).to.equal(ALLOC_B);
      expect(await revenueLock.allocation(beneficiaryC.address)).to.equal(ALLOC_C);
    });

    it("should have correct total allocation", async function () {
      expect(await revenueLock.totalAllocation()).to.equal(TOTAL_LOCK);
    });

    it("should hold the full ARM balance", async function () {
      expect(await armToken.balanceOf(await revenueLock.getAddress())).to.equal(TOTAL_LOCK);
    });

    it("should have 3 beneficiaries", async function () {
      expect(await revenueLock.beneficiaryCount()).to.equal(3);
    });

    it("should have zero released for all beneficiaries", async function () {
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(0);
      expect(await revenueLock.released(beneficiaryB.address)).to.equal(0);
      expect(await revenueLock.released(beneficiaryC.address)).to.equal(0);
    });
  });

  // ============================================================
  // 2. View Functions
  // ============================================================

  describe("View Functions", function () {
    it("unlockPercentage returns 0 at zero revenue", async function () {
      expect(await revenueLock.unlockPercentage()).to.equal(0);
    });

    it("unlockPercentage returns correct bps at each milestone", async function () {
      const milestones = [
        { revenue: REV_10K, expectedBps: 1000n },
        { revenue: REV_50K, expectedBps: 2500n },
        { revenue: REV_100K, expectedBps: 4000n },
        { revenue: REV_250K, expectedBps: 6000n },
        { revenue: REV_500K, expectedBps: 8000n },
        { revenue: REV_1M, expectedBps: 10000n },
      ];

      for (const { revenue, expectedBps } of milestones) {
        // Use attestRevenue (deployer is owner)
        await revenueCounter.attestRevenue(revenue);
        expect(await revenueLock.unlockPercentage()).to.equal(expectedBps);
      }
    });

    it("releasable returns correct amount at 10% unlock", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;
      expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(expected);
    });

    it("releasable returns 0 for non-beneficiary", async function () {
      await revenueCounter.attestRevenue(REV_1M);
      expect(await revenueLock.releasable(nonBeneficiary.address)).to.equal(0);
    });

    it("currentRevenue reads from RevenueCounter", async function () {
      await revenueCounter.attestRevenue(REV_50K);
      expect(await revenueLock.currentRevenue()).to.equal(REV_50K);
    });
  });

  // ============================================================
  // 3. Release Mechanics
  // ============================================================

  describe("Release", function () {
    it("reverts when revenue is zero", async function () {
      await expect(
        revenueLock.connect(beneficiaryA).release(delegateeX.address)
      ).to.be.revertedWith("RevenueLock: nothing to release");
    });

    it("reverts for non-beneficiary", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await expect(
        revenueLock.connect(nonBeneficiary).release(delegateeX.address)
      ).to.be.revertedWith("RevenueLock: not a beneficiary");
    });

    it("reverts for zero delegatee", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await expect(
        revenueLock.connect(beneficiaryA).release(ethers.ZeroAddress)
      ).to.be.revertedWith("RevenueLock: zero delegatee");
    });

    it("releases 10% at $10k milestone", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(expected);
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(expected);
    });

    it("sets delegation atomically on release", async function () {
      await revenueCounter.attestRevenue(REV_10K);

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeX.address);
    });

    it("delegatee receives voting power after release", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      // Mine a block so getPastVotes captures the checkpoint
      await mine(1);

      const expected = (ALLOC_A * 1000n) / 10000n;
      expect(await armToken.getVotes(delegateeX.address)).to.equal(expected);
    });

    it("reverts on second call at same milestone (nothing new)", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      await expect(
        revenueLock.connect(beneficiaryA).release(delegateeX.address)
      ).to.be.revertedWith("RevenueLock: nothing to release");
    });

    it("releases delta at next milestone", async function () {
      // First release at 10%
      await revenueCounter.attestRevenue(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const firstRelease = (ALLOC_A * 1000n) / 10000n;

      // Second release at 25%
      await revenueCounter.attestRevenue(REV_50K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const totalEntitled = (ALLOC_A * 2500n) / 10000n;
      const secondRelease = totalEntitled - firstRelease;

      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(firstRelease + secondRelease);
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(totalEntitled);
    });

    it("releases full allocation at $1M", async function () {
      await revenueCounter.attestRevenue(REV_1M);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await revenueLock.released(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(0);
    });

    it("emits Released event", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;

      await expect(revenueLock.connect(beneficiaryA).release(delegateeX.address))
        .to.emit(revenueLock, "Released")
        .withArgs(beneficiaryA.address, expected, delegateeX.address, expected);
    });

    it("changes delegatee on subsequent release", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeX.address);

      await revenueCounter.attestRevenue(REV_50K);
      await revenueLock.connect(beneficiaryA).release(delegateeY.address);
      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeY.address);
    });
  });

  // ============================================================
  // 4. Multi-Beneficiary Independence
  // ============================================================

  describe("Multi-Beneficiary", function () {
    it("beneficiaries release independently", async function () {
      await revenueCounter.attestRevenue(REV_100K); // 40% unlock

      // Only A releases
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const expectedA = (ALLOC_A * 4000n) / 10000n;
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(expectedA);

      // B and C haven't released
      expect(await revenueLock.released(beneficiaryB.address)).to.equal(0);
      expect(await revenueLock.released(beneficiaryC.address)).to.equal(0);

      // B releases later
      await revenueLock.connect(beneficiaryB).release(delegateeY.address);
      const expectedB = (ALLOC_B * 4000n) / 10000n;
      expect(await revenueLock.released(beneficiaryB.address)).to.equal(expectedB);
    });

    it("late beneficiary gets full entitled amount on first release", async function () {
      // Revenue reaches $250k (60%) — beneficiary C hasn't released at any prior milestone
      await revenueCounter.attestRevenue(REV_250K);

      await revenueLock.connect(beneficiaryC).release(delegateeX.address);
      const expected = (ALLOC_C * 6000n) / 10000n;
      expect(await revenueLock.released(beneficiaryC.address)).to.equal(expected);
    });
  });

  // ============================================================
  // 5. Supply Conservation
  // ============================================================

  describe("Supply Conservation", function () {
    it("ARM balance + released == totalAllocation after partial releases", async function () {
      await revenueCounter.attestRevenue(REV_250K); // 60%

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      await revenueLock.connect(beneficiaryB).release(delegateeX.address);
      // C doesn't release

      const lockBalance = await armToken.balanceOf(await revenueLock.getAddress());
      const releasedA = await revenueLock.released(beneficiaryA.address);
      const releasedB = await revenueLock.released(beneficiaryB.address);
      const releasedC = await revenueLock.released(beneficiaryC.address);

      expect(lockBalance + releasedA + releasedB + releasedC).to.equal(TOTAL_LOCK);
    });

    it("ARM balance is zero after all beneficiaries fully release", async function () {
      await revenueCounter.attestRevenue(REV_1M);

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      await revenueLock.connect(beneficiaryB).release(delegateeX.address);
      await revenueLock.connect(beneficiaryC).release(delegateeX.address);

      expect(await armToken.balanceOf(await revenueLock.getAddress())).to.equal(0);
    });
  });

  // ============================================================
  // 6. Revenue Counter Integration
  // ============================================================

  describe("Revenue Counter Integration", function () {
    it("works with syncStablecoinRevenue path", async function () {
      // Simulate USDC fees via fee collector (6 decimals → 18 decimals in counter)
      // $10,000 in USDC = 10_000 * 1e6
      await mockFeeCollector.setCumulativeFees(ethers.parseUnits("10000", 6));
      await revenueCounter.syncStablecoinRevenue();

      // Revenue counter should now show $10k in 18 decimals
      expect(await revenueCounter.recognizedRevenueUsd()).to.equal(REV_10K);

      // RevenueLock should see 10% unlock
      expect(await revenueLock.unlockPercentage()).to.equal(1000n);

      // Release should work
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const expected = (ALLOC_A * 1000n) / 10000n;
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(expected);
    });
  });

  // ============================================================
  // 7. Full Lifecycle
  // ============================================================

  describe("Full Lifecycle", function () {
    it("walks through all 6 milestones for one beneficiary", async function () {
      const milestones = [
        { revenue: REV_10K, bps: 1000n },
        { revenue: REV_50K, bps: 2500n },
        { revenue: REV_100K, bps: 4000n },
        { revenue: REV_250K, bps: 6000n },
        { revenue: REV_500K, bps: 8000n },
        { revenue: REV_1M, bps: 10000n },
      ];

      let prevReleased = 0n;

      for (const { revenue, bps } of milestones) {
        await revenueCounter.attestRevenue(revenue);

        const entitled = (ALLOC_A * bps) / 10000n;
        const expectedDelta = entitled - prevReleased;

        expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(expectedDelta);

        await revenueLock.connect(beneficiaryA).release(delegateeX.address);

        expect(await revenueLock.released(beneficiaryA.address)).to.equal(entitled);
        prevReleased = entitled;
      }

      // Fully released
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(0);
    });
  });
});
