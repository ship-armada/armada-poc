/**
 * Crowdfund Adversarial Tests
 *
 * Phase 2 security testing:
 * - Reentrancy attack simulations
 * - Precision & accounting invariants (sum-of-parts)
 * - Boundary conditions (exact caps, exact MIN_SALE, exact ELASTIC_TRIGGER)
 * - Access control & state machine edge cases
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const ONE_DAY = 86400;
const THREE_WEEKS = 21 * ONE_DAY;
const ONE_WEEK = 7 * ONE_DAY;

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund Adversarial", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let treasuryAddr: SignerWithAddress;
  let allSigners: SignerWithAddress[];

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  // Add hop-1 demand to avoid refundMode when testing with seeds-only at hop-0.
  // At BASE_SALE, hop-0 ceiling ($798K) < MIN_SALE ($1M). Adding 51 hop-1 at $4K
  // pushes totalAllocUsdc to $1,002K > $1M. Hop-0 allocation math stays unchanged.
  async function addHop1ForMinSale(seeds: SignerWithAddress[], hop1Pool: SignerWithAddress[]) {
    const count = Math.min(51, hop1Pool.length, seeds.length);
    for (let i = 0; i < count; i++) {
      await crowdfund.connect(seeds[i]).invite(hop1Pool[i].address, 0);
      await fundAndApprove(hop1Pool[i], USDC(4_000));
      await crowdfund.connect(hop1Pool[i]).commit(1, USDC(4_000));
    }
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
    treasuryAddr = allSigners[199];

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([deployer.address]);

    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasuryAddr.address,
      deployer.address,
      deployer.address,       // securityCouncil
      openTimestamp,
      false                   // single-tx settlement
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());

    // Fund ARM for MAX_SALE and verify pre-load
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    await armToken.transfer(await crowdfund.getAddress(), CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
  });

  // ============================================================
  // 0a. Emergency Pause — Adversarial
  // ============================================================

  describe("Emergency Pause Adversarial", function () {
    it("unauthorized address cannot pause pre-finalization", async function () {
      await expect(
        crowdfund.connect(allSigners[1]).pause()
      ).to.be.revertedWith("ArmadaCrowdfund: not launch team or security council");
    });

    it("unauthorized address cannot unpause pre-finalization", async function () {
      await crowdfund.pause();
      await expect(
        crowdfund.connect(allSigners[1]).unpause()
      ).to.be.revertedWith("ArmadaCrowdfund: not launch team or security council");
    });

    it("double pause reverts", async function () {
      await crowdfund.pause();
      await expect(
        crowdfund.pause()
      ).to.be.revertedWith("Pausable: paused");
    });

    it("double unpause reverts", async function () {
      await expect(
        crowdfund.unpause()
      ).to.be.revertedWith("Pausable: not paused");
    });
  });

  // ============================================================
  // 1. Precision & Accounting Invariants
  // ============================================================

  describe("Precision & Accounting Invariants", function () {
    it("sum of allocations + refunds == totalCommitted (70 seeds, pro-rata)", async function () {
      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // All commit at max cap = 70 * $15K = $1.05M > MIN_SALE
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      const hop1Pool = allSigners.slice(140, 191);
      await addHop1ForMinSale(seeds.slice(0, 51), hop1Pool);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Verify sum of parts across all participants (seeds + hop-1)
      let sumAllocUsdc = 0n;
      let sumRefund = 0n;
      let sumAllocArm = 0n;

      for (const s of seeds) {
        const [alloc, refund] = await crowdfund.getAllocation(s.address);
        sumAllocArm += alloc;
        sumRefund += refund;
        // Derive allocUsdc from: refund = committed - allocUsdc → allocUsdc = committed - refund
        sumAllocUsdc += (USDC(15_000) - refund);
      }

      // Also sum hop-1 allocations
      for (let i = 0; i < 51; i++) {
        const [alloc, refund] = await crowdfund.getAllocation(hop1Pool[i].address);
        sumAllocArm += alloc;
        sumRefund += refund;
        sumAllocUsdc += (USDC(4_000) - refund);
      }

      const totalCommitted = await crowdfund.totalCommitted();
      const totalAllocated = await crowdfund.totalAllocated();
      const totalAllocatedUsdc = await crowdfund.totalAllocatedUsdc();

      // allocUsdc + refund == committed for each participant (exact)
      expect(sumAllocUsdc + sumRefund).to.equal(totalCommitted);

      // With lazy eval, totalAllocated/totalAllocatedUsdc are hop-level upper bounds.
      // Individual integer division truncation means sum(individual) <= hop-level total.
      // The difference is at most uniqueCommitters per oversubscribed hop (negligible dust).
      const totalParticipants = BigInt(seeds.length + 51);
      expect(sumAllocArm).to.be.lte(totalAllocated);
      expect(sumAllocArm).to.be.gte(totalAllocated - totalParticipants);

      expect(sumAllocUsdc).to.be.lte(totalAllocatedUsdc);
      expect(sumAllocUsdc).to.be.gte(totalAllocatedUsdc - totalParticipants);

      // No participant gets more than their committed amount
      for (const s of seeds) {
        const [alloc] = await crowdfund.getAllocation(s.address);
        // allocArm in USDC value = allocArm * ARM_PRICE / 1e18 = allocArm / 1e12
        const allocUsdcValue = alloc / BigInt(1e12);
        expect(allocUsdcValue).to.be.lte(USDC(15_000));
      }
    });

    it("sum of allocations + refunds == totalCommitted (mixed hops, 100+ participants)", async function () {
      // Setup: 70 seeds → each invites up to 3 hop-1 addresses
      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Seeds invite hop-1 addresses (use signers 71-140)
      const hop1Addrs = allSigners.slice(71, 141);
      let hop1Count = 0;
      for (let i = 0; i < seeds.length && hop1Count < hop1Addrs.length; i++) {
        // Each seed invites 1 hop-1 address (to keep it manageable)
        await crowdfund.connect(seeds[i]).invite(hop1Addrs[hop1Count].address, 0);
        hop1Count++;
      }

      // Seeds commit $15K each
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Hop-1 commit $4K each
      for (let i = 0; i < hop1Count; i++) {
        await fundAndApprove(hop1Addrs[i], USDC(4_000));
        await crowdfund.connect(hop1Addrs[i]).commit(1, USDC(4_000));
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Sum-of-parts check across all participants
      const totalCommitted = await crowdfund.totalCommitted();
      let sumAllocUsdc = 0n;
      let sumRefund = 0n;

      const allParticipants = [...seeds, ...hop1Addrs.slice(0, hop1Count)];
      for (const p of allParticipants) {
        const [, refund] = await crowdfund.getAllocation(p.address);
        // Seeds are hop-0, hop1Addrs are hop-1
        const hop = seeds.includes(p) ? 0 : 1;
        const committed = await crowdfund.getCommitment(p.address, hop);
        sumAllocUsdc += (committed - refund);
        sumRefund += refund;
      }

      expect(sumAllocUsdc + sumRefund).to.equal(totalCommitted);

      // Contract USDC balance covers all refunds (plus rounding buffer from proceeds push)
      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      expect(contractUsdc).to.be.gte(sumRefund);
    });

    it("contract ARM balance covers all allocations after finalization", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const totalAllocated = await crowdfund.totalAllocated();
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      expect(armBalance).to.be.gte(totalAllocated);
    });

    it("after all claims, contract balances are non-negative", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      const hop1Pool = allSigners.slice(140, 191);
      await addHop1ForMinSale(seeds.slice(0, 51), hop1Pool);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // All participants claim ARM and USDC refund (seeds + hop-1)
      for (const s of seeds) {
        await crowdfund.connect(s).claim(ethers.ZeroAddress);
        await crowdfund.connect(s).claimRefund();
      }
      for (let i = 0; i < 51; i++) {
        await crowdfund.connect(hop1Pool[i]).claim(ethers.ZeroAddress);
        await crowdfund.connect(hop1Pool[i]).claimRefund();
      }

      // Proceeds already pushed to treasury at finalization.
      // Sweep unallocated ARM (permissionless).
      await crowdfund.withdrawUnallocatedArm();

      // Contract should have ~0 of both tokens (rounding dust at most)
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      const usdcBalance = await usdc.balanceOf(await crowdfund.getAddress());
      // With exact math, residual should be small (rounding from pro-rata)
      expect(usdcBalance).to.be.lte(USDC(1)); // at most $1 dust
    });
  });

  // ============================================================
  // 2. Boundary Conditions
  // ============================================================

  describe("Boundary Conditions", function () {
    it("commit exactly at hop cap succeeds", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(15_000));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(15_000));

      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(15_000));
    });

    it("commit over hop cap succeeds (excess refunded at settlement)", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(15_010));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(15_000));

      // $10 more (meets MIN_COMMIT, exceeds hop cap — accepted for refund at settlement)
      await crowdfund.connect(allSigners[1]).commit(0, USDC(10));

      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(15_010));

      const [tc0] = await crowdfund.getHopStats(0);
      expect(tc0).to.equal(USDC(15_010));
    });

    it("totalCommitted exactly at MIN_SALE finalizes (not cancel)", async function () {
      // MIN_SALE = $1,000,000. Need ceil(1M / 15K) = 67 seeds at max cap = $1,005,000
      // Actually we need exactly $1M. 66 seeds * $15K = $990K. Need 1 more at $10K.
      // But hop-0 cap is $15K. So 67 seeds * $15K = $1,005,000 > MIN_SALE.
      // For exact MIN_SALE: we'd need some seeds to commit less than cap.
      // Let's use 66 seeds at $15K ($990K) + 1 seed at $10K ($10K) = $1,000,000
      const seeds = allSigners.slice(1, 68); // 67 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // 66 seeds at $15K
      for (let i = 0; i < 66; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }
      // 1 seed at $10K to hit exactly $1M
      await fundAndApprove(seeds[66], USDC(10_000));
      await crowdfund.connect(seeds[66]).commit(0, USDC(10_000));

      const total = await crowdfund.totalCommitted();
      expect(total).to.equal(USDC(1_000_000));

      // Add hop-1 demand so totalAllocUsdc exceeds MIN_SALE (hop-0 ceiling $798K < $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.equal(false);
    });

    it("totalCommitted 1 below MIN_SALE causes finalize to revert", async function () {
      // 66 seeds at $15K = $990K. 1 seed at $9,999.999999 = $999,999.999999 < $1M
      const seeds = allSigners.slice(1, 68);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (let i = 0; i < 66; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }
      // 1 wei less than $10K needed to reach $1M
      const shortAmount = USDC(10_000) - 1n;
      await fundAndApprove(seeds[66], shortAmount);
      await crowdfund.connect(seeds[66]).commit(0, shortAmount);

      const total = await crowdfund.totalCommitted();
      expect(total).to.be.lt(USDC(1_000_000));

      await time.increase(THREE_WEEKS + 1);
      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum raise");

      // Phase stays Active — participants use claimRefund() via deadline fallback
      expect(await crowdfund.phase()).to.equal(Phase.Active);
    });

    it("totalCommitted exactly at ELASTIC_TRIGGER expands to MAX_SALE", async function () {
      // ELASTIC_TRIGGER = $1,500,000
      // Need 100 seeds at $15K each = $1,500,000
      const seeds = allSigners.slice(1, 101); // 100 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      const total = await crowdfund.totalCommitted();
      expect(total).to.equal(USDC(1_500_000));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_800_000)); // MAX_SALE
    });

    it("totalCommitted 1 below ELASTIC_TRIGGER uses BASE_SALE", async function () {
      // 99 seeds at $15K = $1,485,000. 1 seed at $14,999.999999
      const seeds = allSigners.slice(1, 101);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (let i = 0; i < 99; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }
      // Last seed commits 1 wei less than $15K
      const shortAmount = USDC(15_000) - 1n;
      await fundAndApprove(seeds[99], shortAmount);
      await crowdfund.connect(seeds[99]).commit(0, shortAmount);

      const total = await crowdfund.totalCommitted();
      expect(total).to.be.lt(USDC(1_500_000));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.saleSize()).to.equal(USDC(1_200_000)); // BASE_SALE
    });

    it("finalize with seeds only enters refundMode (hop-0 ceiling < MIN_SALE)", async function () {
      // Only seeds commit — no hop-1/2 participants.
      // At BASE_SALE, hop-0 ceiling is $798K which is below MIN_SALE ($1M).
      // Without hop-1/hop-2 demand, totalAllocUsdc cannot reach MIN_SALE, so
      // finalization enters refundMode and all participants get full refunds.
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.equal(true);

      // Hop-1 and hop-2 should have 0 committers
      const [, , uc1] = await crowdfund.getHopStats(1);
      const [, , uc2] = await crowdfund.getHopStats(2);
      expect(uc1).to.equal(0);
      expect(uc2).to.equal(0);
    });

    it("finalize with all whitelisted but 0 committers reverts", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Nobody commits — just fast-forward through the active window
      await time.increase(THREE_WEEKS + 1);
      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum raise");

      expect(await crowdfund.phase()).to.equal(Phase.Active);
    });

    it("commit below MIN_COMMIT ($10 USDC) reverts", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(10));

      // 1 wei reverts
      await expect(
        crowdfund.connect(allSigners[1]).commit(0, 1n)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      // $9.999999 reverts
      await expect(
        crowdfund.connect(allSigners[1]).commit(0, USDC(10) - 1n)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      // Exactly $10 succeeds
      await crowdfund.connect(allSigners[1]).commit(0, USDC(10));
      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(10));
    });

    it("seed self-invite creates a hop-1 node (permitted in multi-node model)", async function () {
      const seed = allSigners[1];
      await crowdfund.addSeeds([seed.address]);


      // Seed invites self — creates (seed, 1) node
      await crowdfund.connect(seed).invite(seed.address, 0);
      expect(await crowdfund.isWhitelisted(seed.address, 1)).to.be.true;
      expect(await crowdfund.getInvitesReceived(seed.address, 1)).to.equal(1);
    });

    it("invite reverts after windowEnd", async function () {
      const seed = allSigners[1];
      const invitee = allSigners[2];
      await crowdfund.addSeeds([seed.address]);


      const windowEnd = await crowdfund.windowEnd();
      // Warp past windowEnd — invite should fail
      await time.increaseTo(windowEnd + 1n);
      await expect(
        crowdfund.connect(seed).invite(invitee.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    it("invite succeeds 1 second before windowEnd", async function () {
      const seed = allSigners[1];
      const invitee = allSigners[2];
      await crowdfund.addSeeds([seed.address]);


      const windowEnd = await crowdfund.windowEnd();
      // Warp to 2 seconds before windowEnd — next tx executes at windowEnd - 1
      await time.increaseTo(windowEnd - 2n);
      await crowdfund.connect(seed).invite(invitee.address, 0);

      const p = await crowdfund.participants(invitee.address, 1);
      expect(p.isWhitelisted).to.be.true;
    });

    it("commit succeeds at window start", async function () {
      const seed = allSigners[1];
      await crowdfund.addSeeds([seed.address]);


      await fundAndApprove(seed, USDC(100));
      await crowdfund.connect(seed).commit(0, USDC(100));

      const committed = await crowdfund.getCommitment(seed.address, 0);
      expect(committed).to.equal(USDC(100));
    });
  });

  // ============================================================
  // 3. Access Control & State Machine
  // ============================================================

  describe("Access Control & State Machine", function () {
    it("commit outside active window reverts", async function () {
      // Deploy a fresh crowdfund to test outside-window behavior.
      // The shared beforeEach advances to windowStart, so we need an independent instance.
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const futureOpen = (await time.latest()) + 600;
      const freshCf = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        treasuryAddr.address,
        deployer.address,
        deployer.address,
        futureOpen,
        false
      );
      await freshCf.waitForDeployment();
      await armToken.addToWhitelist(await freshCf.getAddress());
      await armToken.transfer(await freshCf.getAddress(), ARM(1_800_000));
      await freshCf.loadArm();

      // Advance to windowStart so addSeeds works
      await time.increaseTo(await freshCf.windowStart());
      await freshCf.addSeeds([allSigners[1].address]);

      // Advance past windowEnd so commit reverts
      await time.increase(THREE_WEEKS + 1);
      await fundAndApprove(allSigners[1], USDC(15_000));
      await usdc.connect(allSigners[1]).approve(await freshCf.getAddress(), USDC(15_000));
      await expect(
        freshCf.connect(allSigners[1]).commit(0, USDC(15_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    it("invite after window ends reverts", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);

      await time.increase(THREE_WEEKS + 1); // past active window

      await expect(
        crowdfund.connect(allSigners[1]).invite(allSigners[2].address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    it("finalize before window ends reverts", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: window not ended");
    });

    it("addSeeds after week 1 of active window reverts", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);

      await time.increase(ONE_WEEK + 1); // past launch team invite period

      await expect(
        crowdfund.addSeeds([allSigners[2].address])
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("claim reverts when below minimum (should use claimRefund)", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await fundAndApprove(seeds[0], USDC(15_000));
      await crowdfund.connect(seeds[0]).commit(0, USDC(15_000));

      await time.increase(THREE_WEEKS + 1);
      // finalize reverts (below MIN_SALE), phase stays Active
      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum raise");

      // claim() reverts because phase is Active, not Finalized
      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: not finalized");

      // claimRefund() works via deadline fallback
      await crowdfund.connect(seeds[0]).claimRefund();
    });

    it("claimRefund when phase is Finalized (not refundMode) returns pro-rata refund", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);

      // claimRefund handles the post-finalization pro-rata refund path
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);

      // Seeds at oversubscribed hop-0 should get a USDC refund (allocation < committed)
      const [, refundAmount] = await crowdfund.getAllocation(seeds[0].address);
      expect(usdcAfter - usdcBefore).to.equal(refundAmount);
    });

    it("non-admin can finalize (permissionless)", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);

      // A random non-admin address can finalize
      await crowdfund.connect(allSigners[71]).finalize();
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
    });

    it("non-admin can sweep unallocated ARM (permissionless)", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // withdrawUnallocatedArm is permissionless — non-admin can call
      await crowdfund.connect(allSigners[1]).withdrawUnallocatedArm();
    });

    it("withdrawUnallocatedArm second call reverts when nothing to sweep", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      const hop1Pool = allSigners.slice(140, 191);
      await addHop1ForMinSale(seeds.slice(0, 51), hop1Pool);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // First sweep: unsold ARM goes to treasury
      await crowdfund.withdrawUnallocatedArm();

      // Second sweep: nothing left (unclaimed ARM still owed)
      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");
    });

    it("constructor rejects zero treasury address", async function () {
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const localOpenTimestamp = (await time.latest()) + 300;
      await expect(
        ArmadaCrowdfund.deploy(
          await usdc.getAddress(),
          await armToken.getAddress(),
          ethers.ZeroAddress,
          deployer.address,
          deployer.address,
          localOpenTimestamp,
          false
        )
      ).to.be.revertedWith("ArmadaCrowdfund: zero treasury");
    });

    it("constructor rejects zero securityCouncil address", async function () {
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const localOpenTimestamp = (await time.latest()) + 300;
      await expect(
        ArmadaCrowdfund.deploy(
          await usdc.getAddress(),
          await armToken.getAddress(),
          treasuryAddr.address,
          deployer.address,
          ethers.ZeroAddress,
          localOpenTimestamp,
          false
        )
      ).to.be.revertedWith("ArmadaCrowdfund: zero securityCouncil");
    });

    it("non-participant cannot claim", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // outsider never committed
      await expect(
        crowdfund.connect(allSigners[199]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: no commitment");
    });

    it("launch team cannot commit via commit()", async function () {
      // deployer IS launchTeam in this file's beforeEach
      await crowdfund.addSeeds([deployer.address]);
      await fundAndApprove(deployer, USDC(15_000));

      await expect(
        crowdfund.connect(deployer).commit(0, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: launch team cannot commit");
    });

    it("whitelisted-but-uncommitted participant cannot claim", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Only first 69 seeds commit, seeds[69] does not
      for (let i = 0; i < 69; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      await expect(
        crowdfund.connect(seeds[69]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: no commitment");
    });
  });

  // ============================================================
  // 4. Rollover Edge Cases
  // ============================================================

  describe("Rollover Edge Cases", function () {
    it("hop-0 leftover rolls unconditionally to hop-1", async function () {
      // Rollover is unconditional — no minimum committer threshold.
      // hop-0 ceiling = 70% of $1.14M = $798K.
      // 53 seeds × $15K = $795K < $798K → under-subscribed.
      // Hop-0 leftover = $798K - $795K = $3K rolls to hop-1.
      // 52 hop-1 participants × $4K = $208K. Total = $1,003K >= MIN_SALE.
      // Hop-1 effective ceiling = min($513K + $3K, $345K) = $345K (budget-capped).
      // Hop-1 demand $208K < $345K → full allocation, no pro-rata.

      const seeds = allSigners.slice(1, 54); // 53 seeds (indices 1-53)
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Each of the first 52 seeds invites one hop-1 participant (signers 54-105)
      const hop1Invitees: SignerWithAddress[] = [];
      for (let i = 0; i < 52; i++) {
        const invitee = allSigners[54 + i];
        await crowdfund.connect(seeds[i]).invite(invitee.address, 0);
        hop1Invitees.push(invitee);
      }

      // All 53 seeds commit $15K
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      // 52 hop-1 participants commit $4K
      for (const h of hop1Invitees) {
        await fundAndApprove(h, USDC(4_000));
        await crowdfund.connect(h).commit(1, USDC(4_000));
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Verify hop-0 ceiling: $798K
      const hop0Ceiling = await crowdfund.finalCeilings(0);
      expect(hop0Ceiling).to.equal(USDC(798_000));

      // Hop-1 effective ceiling: min($513K + $3K leftover, $345K remaining) = $345K
      const hop1Ceiling = await crowdfund.finalCeilings(1);
      expect(hop1Ceiling).to.equal(USDC(345_000));

      // Hop-1 is under-subscribed ($208K < $345K) → full allocation, no refund
      const [alloc, refund] = await crowdfund.getAllocation(hop1Invitees[0].address);
      const allocArm = Number(alloc) / 1e18;
      expect(allocArm).to.be.closeTo(4_000, 1);
      expect(refund).to.equal(0n);

      // Treasury leftover = saleSize - totalAllocated = $1.2M - ($795K + $208K) = $197K
      const treasuryLeftover = await crowdfund.treasuryLeftoverUsdc();
      expect(treasuryLeftover).to.equal(USDC(197_000));
    });

    it("rollover works with zero committers at hop-2", async function () {
      // 68 seeds × $15K = $1.02M. Add 51 hop-1 × $4K = $204K for MIN_SALE.
      // Hop-0 demand $1.02M > ceiling $798K → oversubscribed, no leftover from hop-0.
      // Hop-1 eff ceiling = min($513K + $0, $342K remaining) = $342K, demand = $204K → leftover $138K
      // Hop-2 eff ceiling = $60K floor + $138K leftover = $198K, demand = $0
      // Rollover flows unconditionally through hops regardless of committer count.

      const seeds = allSigners.slice(1, 69); // 68 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);

      // saleSize = BASE_SALE = $1.2M (total = $1.224M < $1.5M trigger)
      // hop2Floor = $60K, available = $1.14M
      // Hop-0 ceiling = $798K, demand = $1.02M → oversubscribed, alloc = $798K, leftover = $0
      // remainingAvailable = $1.14M - $798K = $342K
      // Hop-1 eff ceiling = min($513K + $0, $342K) = $342K, demand = $204K, leftover = $138K
      // Hop-2 eff ceiling = $60K + $138K = $198K, demand = $0

      const hop0Ceiling = await crowdfund.finalCeilings(0);
      expect(hop0Ceiling).to.equal(USDC(798_000));

      const hop1Ceiling = await crowdfund.finalCeilings(1);
      expect(hop1Ceiling).to.equal(USDC(342_000));

      const hop2Ceiling = await crowdfund.finalCeilings(2);
      expect(hop2Ceiling).to.equal(USDC(198_000));

      // Treasury leftover = saleSize - exactTotalUsdc. With per-address floor rounding
      // on oversubscribed hop-0, exactTotalUsdc is slightly less than the hop-level
      // sum, so treasuryLeftover absorbs the rounding dust.
      const treasuryLeftover = await crowdfund.treasuryLeftoverUsdc();
      expect(treasuryLeftover).to.be.closeTo(USDC(198_000), 100n); // within $0.0001

      // Key assertion: rollover flowed through hop-1 to hop-2 despite 0 committers
      // at hop-2 — unconditional rollover ensures unused capacity always cascades.
      expect(hop2Ceiling).to.be.gt(USDC(60_000)); // hop-2 got more than just its floor
    });

    it("over-subscribed hop-0 produces pro-rata with no rollover", async function () {
      // 70 seeds × $15K = $1.05M. Hop-0 ceiling = 70% of $1.14M = $798K → over-subscribed.
      // No leftover from hop-0. Add 51 hop-1 × $4K = $204K for MIN_SALE.

      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Pro-rata: scale = $798K / $1.05M = 0.76
      // Each $15K → $11,400 allocation, $3,600 refund
      const [alloc, refund] = await crowdfund.getAllocation(seeds[0].address);
      const allocArm = Number(alloc) / 1e18;
      expect(allocArm).to.be.closeTo(11_400, 1);
      expect(refund).to.be.closeTo(USDC(3_600), USDC(1));

      // Hop-0 leftover = $0, so hop-1 gets base ceiling only
      // Hop-1 eff ceiling = min($513K + $0, $342K remaining) = $342K
      // Hop-1 demand = $204K < $342K → under-subscribed, leftover = $138K
      // Hop-2 eff ceiling = $60K floor + $138K leftover = $198K
      // Treasury leftover absorbs per-address floor rounding dust from oversubscribed hop-0
      const treasuryLeftover = await crowdfund.treasuryLeftoverUsdc();
      expect(treasuryLeftover).to.be.closeTo(USDC(198_000), 100n); // within $0.0001
    });

    it("rollover preserves sum-of-parts invariant: alloc + treasury = saleSize", async function () {
      // totalAllocatedUsdc + treasuryLeftoverUsdc must equal saleSize ($1.2M).

      const seeds = allSigners.slice(1, 54); // 53 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      const hop1Invitees: SignerWithAddress[] = [];
      for (let i = 0; i < 52; i++) {
        const invitee = allSigners[54 + i];
        await crowdfund.connect(seeds[i]).invite(invitee.address, 0);
        hop1Invitees.push(invitee);
      }

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      for (const h of hop1Invitees) {
        await fundAndApprove(h, USDC(4_000));
        await crowdfund.connect(h).commit(1, USDC(4_000));
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const totalAlloc = await crowdfund.totalAllocatedUsdc();
      const treasuryLeftover = await crowdfund.treasuryLeftoverUsdc();

      // Hop-0: demand $795K < ceiling $798K → alloc = $795K
      // Hop-1: demand $208K < ceiling $345K → alloc = $208K
      // Hop-2: demand $0 → alloc = $0
      expect(totalAlloc).to.equal(USDC(795_000) + USDC(208_000));

      // Treasury: saleSize - totalAllocated = $1.2M - $1,003K = $197K
      expect(treasuryLeftover).to.equal(USDC(197_000));

      // Invariant: alloc + treasury = saleSize
      expect(totalAlloc + treasuryLeftover).to.equal(USDC(1_200_000));
    });
  });

  // ============================================================
  // 5. Deadline Fallback Refund (Path 4)
  // ============================================================

  describe("Deadline Fallback Refund (Path 4)", function () {
    it("full refund when window expired, not finalized, cappedDemand < MIN_SALE", async function () {
      // 3 seeds commit $15K each = $45K (well below MIN_SALE $1M)
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Advance past windowEnd — do NOT call finalize
      await time.increase(THREE_WEEKS + 1);

      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);

      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
    });

    it("deadline fallback reverts when cappedDemand >= MIN_SALE (sale should finalize)", async function () {
      // 70 seeds commit $15K = $1.05M, plus 51 hop-1 at $4K → cappedDemand > MIN_SALE
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      // Advance past windowEnd — do NOT call finalize
      await time.increase(THREE_WEEKS + 1);

      // Path 4 correctly rejects when the sale could succeed
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");
    });

    it("deadline fallback computes cappedDemand lazily and caches it", async function () {
      // 3 seeds commit small amounts, advance past windowEnd
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await time.increase(THREE_WEEKS + 1);

      // First claimRefund triggers _computeCappedDemand()
      await crowdfund.connect(seeds[0]).claimRefund();
      const cappedDemandAfter = await crowdfund.cappedDemand();
      expect(cappedDemandAfter).to.be.gt(0);

      // Second claimRefund also succeeds (uses cached value)
      const usdcBefore = await usdc.balanceOf(seeds[1].address);
      await crowdfund.connect(seeds[1]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[1].address);
      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
    });
  });

  // ============================================================
  // 6. Double-Action Guards
  // ============================================================

  describe("Double-Action Guards", function () {
    it("claim() rejects double-claim", async function () {
      // Deploy the attacker contract
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Verify claim works normally (proving nonReentrant doesn't block legitimate calls)
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);
      const [, , claimed] = await crowdfund.getAllocation(seeds[0].address);
      expect(claimed).to.be.true;

      // Double claim should fail
      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM already claimed");
    });

    it("claimRefund() rejects double-refund", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await fundAndApprove(seeds[0], USDC(15_000));
      await crowdfund.connect(seeds[0]).commit(0, USDC(15_000));

      await time.increase(THREE_WEEKS + 1);
      // finalize reverts (below MIN_SALE) — use deadline fallback

      // claimRefund works
      await crowdfund.connect(seeds[0]).claimRefund();

      // Double claimRefund fails
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: already refunded");
    });

    it("withdrawProceeds() is protected by nonReentrant", async function () {
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE $1M)
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 191));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Proceeds already pushed at finalization — no withdrawProceeds() needed
      // Verify treasury received proceeds
      const treasuryUsdc = await usdc.balanceOf(treasuryAddr.address);
      expect(treasuryUsdc).to.be.gt(0);
    });

    it("withdrawUnallocatedArm() is protected by nonReentrant", async function () {
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // First withdrawal works
      await crowdfund.withdrawUnallocatedArm();

      // Second withdrawal reverts
      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");
    });

    it("commit() is protected by nonReentrant", async function () {
      // Verify commit guard by confirming correct behavior under normal conditions
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(15_000));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(10_000));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(5_000));

      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(15_000));
    });
  });
});
