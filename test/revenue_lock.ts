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
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
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

  // Rate cap for the observed-revenue ratchet: $10k/day (18-decimal USD).
  // Matches PARAMETER_MANIFEST.md / issue #225.
  const MAX_INCREASE_PER_DAY = ethers.parseUnits("10000", 18);
  const ONE_DAY = 24 * 60 * 60;

  /**
   * Attest cumulative revenue AND advance the chain clock enough that the ratchet
   * can absorb the full increment on the next sync/release. Keeps milestone/release
   * tests isolated from rate-limit semantics (which are covered by the dedicated
   * ratchet test suite below).
   */
  async function attestRevenueWithBudget(revenue: bigint) {
    const current: bigint = await revenueLock.maxObservedRevenue();
    if (revenue > current) {
      const needed = revenue - current;
      // Ceil-divide, plus one extra day as a safety cushion.
      const daysNeeded = Number(needed / MAX_INCREASE_PER_DAY) + 1;
      await time.increase(daysNeeded * ONE_DAY);
    }
    await revenueCounter.attestRevenue(revenue);
  }

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
      MAX_INCREASE_PER_DAY,
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
        await attestRevenueWithBudget(revenue);
        expect(await revenueLock.unlockPercentage()).to.equal(expectedBps);
      }
    });

    it("releasable returns correct amount at 10% unlock", async function () {
      await attestRevenueWithBudget(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;
      expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(expected);
    });

    it("releasable returns 0 for non-beneficiary", async function () {
      await attestRevenueWithBudget(REV_1M);
      expect(await revenueLock.releasable(nonBeneficiary.address)).to.equal(0);
    });

    it("currentRevenue reads from RevenueCounter", async function () {
      await attestRevenueWithBudget(REV_50K);
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
      await attestRevenueWithBudget(REV_10K);
      await expect(
        revenueLock.connect(nonBeneficiary).release(delegateeX.address)
      ).to.be.revertedWith("RevenueLock: not a beneficiary");
    });

    it("reverts for zero delegatee", async function () {
      await attestRevenueWithBudget(REV_10K);
      await expect(
        revenueLock.connect(beneficiaryA).release(ethers.ZeroAddress)
      ).to.be.revertedWith("RevenueLock: zero delegatee");
    });

    it("releases 10% at $10k milestone", async function () {
      await attestRevenueWithBudget(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(expected);
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(expected);
    });

    it("sets delegation atomically on release", async function () {
      await attestRevenueWithBudget(REV_10K);

      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeX.address);
    });

    it("delegatee receives voting power after release", async function () {
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      // Mine a block so getPastVotes captures the checkpoint
      await mine(1);

      const expected = (ALLOC_A * 1000n) / 10000n;
      expect(await armToken.getVotes(delegateeX.address)).to.equal(expected);
    });

    it("reverts on second call at same milestone (nothing new)", async function () {
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      await expect(
        revenueLock.connect(beneficiaryA).release(delegateeX.address)
      ).to.be.revertedWith("RevenueLock: nothing to release");
    });

    it("releases delta at next milestone", async function () {
      // First release at 10%
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const firstRelease = (ALLOC_A * 1000n) / 10000n;

      // Second release at 25%
      await attestRevenueWithBudget(REV_50K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      const totalEntitled = (ALLOC_A * 2500n) / 10000n;
      const secondRelease = totalEntitled - firstRelease;

      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(firstRelease + secondRelease);
      expect(await revenueLock.released(beneficiaryA.address)).to.equal(totalEntitled);
    });

    it("releases full allocation at $1M", async function () {
      await attestRevenueWithBudget(REV_1M);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);

      expect(await revenueLock.released(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await armToken.balanceOf(beneficiaryA.address)).to.equal(ALLOC_A);
      expect(await revenueLock.releasable(beneficiaryA.address)).to.equal(0);
    });

    it("emits Released event", async function () {
      await attestRevenueWithBudget(REV_10K);
      const expected = (ALLOC_A * 1000n) / 10000n;

      await expect(revenueLock.connect(beneficiaryA).release(delegateeX.address))
        .to.emit(revenueLock, "Released")
        .withArgs(beneficiaryA.address, expected, delegateeX.address, expected);
    });

    it("changes delegatee on subsequent release", async function () {
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.connect(beneficiaryA).release(delegateeX.address);
      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeX.address);

      await attestRevenueWithBudget(REV_50K);
      await revenueLock.connect(beneficiaryA).release(delegateeY.address);
      expect(await armToken.delegates(beneficiaryA.address)).to.equal(delegateeY.address);
    });
  });

  // ============================================================
  // 4. Multi-Beneficiary Independence
  // ============================================================

  describe("Multi-Beneficiary", function () {
    it("beneficiaries release independently", async function () {
      await attestRevenueWithBudget(REV_100K); // 40% unlock

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
      await attestRevenueWithBudget(REV_250K);

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
      await attestRevenueWithBudget(REV_250K); // 60%

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
      await attestRevenueWithBudget(REV_1M);

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

      // Advance the chain clock enough for the ratchet budget to absorb $10k,
      // then sync the ratchet. Without this, the rate cap leaves
      // maxObservedRevenue at 0 and downstream entitlement would be 0.
      await time.increase(2 * ONE_DAY);
      await revenueLock.syncObservedRevenue();

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
        await attestRevenueWithBudget(revenue);

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

  // ============================================================
  // 8. Ratchet + Rate-Limit
  // ============================================================
  //
  // End-to-end integration tests for the monotonic ratchet and daily rate cap
  // that guard against RevenueCounter governance-upgrade attacks. These tests
  // use the REAL RevenueCounter (UUPS proxy, not a mock) so they exercise the
  // full governance + ratchet interaction.

  describe("Ratchet + Rate Limit", function () {
    it("initializes lastSyncTimestamp to deployment time (not zero)", async function () {
      // WHY: issue #225 auditor checklist — a zero lastSyncTimestamp would make
      // the first observation see enormous elapsed time and bypass the rate cap.
      const ts = await revenueLock.lastSyncTimestamp();
      expect(ts).to.be.gt(0);
      // Must be recent (within the last minute — block.timestamp at deploy).
      const now = await time.latest();
      expect(Number(ts)).to.be.closeTo(now, 60);
    });

    it("initializes MAX_REVENUE_INCREASE_PER_DAY to the spec-calibrated value", async function () {
      expect(await revenueLock.MAX_REVENUE_INCREASE_PER_DAY()).to.equal(MAX_INCREASE_PER_DAY);
    });

    it("starts maxObservedRevenue at zero, even if counter has history", async function () {
      // WHY: also from the auditor checklist — the ratchet must NOT be seeded
      // from the counter, otherwise a malicious initial counter implementation
      // could pre-populate the ratchet.
      expect(await revenueLock.maxObservedRevenue()).to.equal(0);
    });

    it("rate-caps instant acceleration from a malicious counter jump", async function () {
      // WHY: the acceleration attack from #225. Even if governance upgrades
      // RevenueCounter to report a huge value, only MAX_INCREASE_PER_DAY can
      // flow into maxObservedRevenue per elapsed day.
      await revenueCounter.attestRevenue(ethers.parseUnits("10000000", 18)); // $10M
      await time.increase(ONE_DAY);
      await revenueLock.syncObservedRevenue();

      // Tolerance: hardhat mines one block per tx between `lastSyncTimestamp`
      // (set in the RevenueLock constructor) and this sync, so a handful of
      // extra seconds of budget accumulate beyond the literal one-day value.
      // The cap is still ~$10k — orders of magnitude below $10M — which is
      // all the anti-acceleration property requires.
      const tolerance = (MAX_INCREASE_PER_DAY * 60n) / 86400n; // up to 60s of budget
      const actual = await revenueLock.maxObservedRevenue();
      expect(actual).to.be.gte(MAX_INCREASE_PER_DAY);
      expect(actual).to.be.lte(MAX_INCREASE_PER_DAY + tolerance);
      expect(await revenueLock.unlockPercentage()).to.equal(1000n); // only 10% unlocked
    });

    it("holds firm against a would-be rewind (but counter is monotonic anyway)", async function () {
      // WHY: while the real RevenueCounter refuses non-monotonic attestations,
      // a malicious UUPS upgrade could bypass that check entirely by replacing
      // the implementation. The ratchet must not rely on the counter being
      // well-behaved — that's the whole point.
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.syncObservedRevenue();
      expect(await revenueLock.maxObservedRevenue()).to.equal(REV_10K);

      // Note: we cannot actually downgrade the real counter without deploying
      // a replacement impl. The Foundry tests cover the rewind-immunity property
      // with a mock counter. Here we verify the ratchet at least doesn't reset
      // itself on its own — a sync with no new revenue must keep it stable.
      await time.increase(ONE_DAY);
      await revenueLock.syncObservedRevenue();
      expect(await revenueLock.maxObservedRevenue()).to.equal(REV_10K);
    });

    it("advances lastSyncTimestamp on every sync — including no-ops", async function () {
      // WHY: the central mechanism that makes regular syncs meaningful. Without
      // this, budget accumulates indefinitely during quiet periods.
      const before = await revenueLock.lastSyncTimestamp();
      await time.increase(ONE_DAY);
      await revenueLock.syncObservedRevenue(); // counter is at 0 — this is a no-op
      const after = await revenueLock.lastSyncTimestamp();
      expect(after).to.be.gt(before);
    });

    it("exposes a permissionless sync for monitoring bots", async function () {
      // WHY: operational security model requires that any monitoring address
      // can call syncObservedRevenue without holding special privileges.
      await attestRevenueWithBudget(REV_10K);
      await revenueLock.connect(nonBeneficiary).syncObservedRevenue();
      expect(await revenueLock.maxObservedRevenue()).to.equal(REV_10K);
    });

    it("getCappedObservedRevenue previews what a sync would produce", async function () {
      // WHY: off-chain monitoring needs a view that exactly mirrors the
      // state-modifying sync. Divergence would make monitoring unreliable.
      await revenueCounter.attestRevenue(REV_50K);
      await time.increase(10 * ONE_DAY);

      const predicted = await revenueLock.getCappedObservedRevenue();
      await revenueLock.syncObservedRevenue();
      expect(await revenueLock.maxObservedRevenue()).to.equal(predicted);
    });

    it("emits ObservedRevenueUpdated on actual ratchet advance", async function () {
      await revenueCounter.attestRevenue(REV_10K);
      await time.increase(2 * ONE_DAY);

      // Advance actually happens — event must fire with raw reported value.
      await expect(revenueLock.syncObservedRevenue())
        .to.emit(revenueLock, "ObservedRevenueUpdated")
        .withArgs(0n, REV_10K, REV_10K);
    });

    it("does NOT emit ObservedRevenueUpdated on a no-op sync", async function () {
      await time.increase(ONE_DAY);
      // Counter is at 0, ratchet is at 0 — no advance possible.
      await expect(revenueLock.syncObservedRevenue())
        .to.not.emit(revenueLock, "ObservedRevenueUpdated");
    });
  });
});
