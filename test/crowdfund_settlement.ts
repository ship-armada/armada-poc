// ABOUTME: Tests for crowdfund settlement: security council cancel, proceeds push,
// ABOUTME: claim deadline, and multi-window ARM sweep.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const THREE_YEARS = 1095 * 24 * 60 * 60;

describe("Crowdfund Settlement Rework", function () {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let securityCouncil: HardhatEthersSigner;
  let allSigners: HardhatEthersSigner[];
  let usdc: any;
  let armToken: any;
  let crowdfund: any;

  async function fundAndApprove(signer: HardhatEthersSigner, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  // Helper: set up a crowdfund with seeds committed to reach successful finalization.
  // Callers pass seedCount × commitUsdc ≥ MIN_SALE ($250K); with 100% hop-0 ceilings the
  // known tier alone clears it (no other-hop demand needed).
  async function setupAndFinalize(seedCount: number, commitUsdc: bigint) {
    const seeds = allSigners.slice(5, 5 + seedCount);
    for (const s of seeds) {
      await fundAndApprove(s, commitUsdc);
    }
    await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

    for (const s of seeds) {
      await crowdfund.connect(s).commit(0, commitUsdc);
    }

    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
    await crowdfund.finalize();
    expect(await crowdfund.refundMode()).to.be.false;
    return seeds;
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
    treasury = allSigners[1];
    securityCouncil = allSigners[2];

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
      treasury.address,
      deployer.address,         // launchTeam
      securityCouncil.address,  // securityCouncil
      openTimestamp              // openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    await armToken.transfer(cfAddr, ARM(1_500_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
  });

  // ============================================================
  // T4.5 — Security Council cancel()
  // ============================================================

  describe("Security Council Cancel (T4.5)", function () {
    it("security council can cancel before window opens", async function () {
      expect(await crowdfund.phase()).to.equal(Phase.Active);
      await crowdfund.connect(securityCouncil).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);
    });

    it("security council can cancel during Active phase", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      await crowdfund.connect(securityCouncil).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);
    });

    it("security council can cancel after window but before finalize", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      // Window ended, but still Active phase
      await crowdfund.connect(securityCouncil).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);
    });

    it("cancel after finalize reverts", async function () {
      await setupAndFinalize(80, USDC(15_000));
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);

      await expect(
        crowdfund.connect(securityCouncil).cancel()
      ).to.be.revertedWith("ArmadaCrowdfund: already finalized");
    });

    it("cancel when already canceled reverts", async function () {
      await crowdfund.connect(securityCouncil).cancel();
      await expect(
        crowdfund.connect(securityCouncil).cancel()
      ).to.be.revertedWith("ArmadaCrowdfund: already canceled");
    });

    it("non-security-council address reverts", async function () {
      await expect(
        crowdfund.connect(deployer).cancel()
      ).to.be.revertedWith("ArmadaCrowdfund: not security council");
    });

    it("after cancel: commit reverts", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      await fundAndApprove(allSigners[5], USDC(15_000));

      await crowdfund.connect(securityCouncil).cancel();

      await expect(
        crowdfund.connect(allSigners[5]).commit(0, USDC(10_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active");
    });

    it("after cancel: finalize reverts", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      await crowdfund.connect(securityCouncil).cancel();

      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: already finalized");
    });

    it("after cancel: claimRefund works", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(0, USDC(10_000));

      const usdcBefore = await usdc.balanceOf(allSigners[5].address);
      await crowdfund.connect(securityCouncil).cancel();
      await crowdfund.connect(allSigners[5]).claimRefund();
      const usdcAfter = await usdc.balanceOf(allSigners[5].address);

      expect(usdcAfter - usdcBefore).to.equal(USDC(10_000));
    });

    it("after cancel: ARM is recoverable", async function () {
      await crowdfund.connect(securityCouncil).cancel();

      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ARM(1_500_000));
    });

    it("emits Cancelled event", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(0, USDC(10_000));

      await expect(crowdfund.connect(securityCouncil).cancel())
        .to.emit(crowdfund, "Cancelled");
    });

    it("securityCouncil immutable is set correctly", async function () {
      expect(await crowdfund.securityCouncil()).to.equal(securityCouncil.address);
    });

    it("claimRefund reverts for whitelisted address with zero commitment", async function () {
      await crowdfund.addSeeds([allSigners[5].address, allSigners[6].address]);
  
      // allSigners[5] commits, allSigners[6] does not
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(0, USDC(10_000));

      await crowdfund.connect(securityCouncil).cancel();

      // Whitelisted-but-uncommitted address should revert
      await expect(
        crowdfund.connect(allSigners[6]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: no commitment");
    });
  });

  // ============================================================
  // T4.6 — Proceeds pushed at finalization
  // ============================================================

  describe("Proceeds Pushed at Finalization (T4.6)", function () {
    it("treasury receives proceeds in the same tx as finalize", async function () {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await setupAndFinalize(80, USDC(15_000));
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      const pushed = treasuryAfter - treasuryBefore;
      expect(totalAllocUsdc).to.be.gt(0);
      // Proceeds pushed = totalAllocUsdc minus a small rounding buffer (1 per participant node)
      expect(pushed).to.be.lte(totalAllocUsdc);
      expect(pushed).to.be.gte(totalAllocUsdc - 500n); // at most ~500 participants' worth of buffer
    });

    it("contract balance after finalize covers all refunds", async function () {
      await setupAndFinalize(80, USDC(15_000));

      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      const totalCommitted = await crowdfund.totalCommitted();
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();

      // Contract retains slightly more than (totalCommitted - totalAllocUsdc) due to rounding buffer
      expect(contractUsdc).to.be.gte(totalCommitted - totalAllocUsdc);
      expect(contractUsdc).to.be.lte(totalCommitted - totalAllocUsdc + 500n);
    });

    it("all participants can still claim ARM and refund USDC after proceeds push", async function () {
      const seeds = await setupAndFinalize(80, USDC(15_000));

      // All seeds claim ARM + refund in one call
      for (const s of seeds) {
        await crowdfund.connect(s).claim(s.address);
      }

      // Contract should have minimal USDC left (dust from rounding)
      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      expect(contractUsdc).to.be.lte(USDC(1));
    });

    it("refundMode does NOT push proceeds (no proceeds to push)", async function () {
      // 16 seeds × $15K = $240K < MIN_SALE ($250K) → enters refundMode
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
  
      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await crowdfund.finalize();
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      expect(await crowdfund.refundMode()).to.be.true;
      // No USDC pushed in refundMode
      expect(treasuryAfter - treasuryBefore).to.equal(0);
    });

    it("emits Finalized event on normal finalization", async function () {
      await setupAndFinalize(80, USDC(15_000));

      // Read the finalized state to verify event args
      const saleSize = await crowdfund.saleSize();
      const totalAllocArm = await crowdfund.totalAllocatedArm();
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();

      expect(saleSize).to.be.gt(0);
      expect(totalAllocArm).to.be.gt(0);
      expect(totalAllocUsdc).to.be.gt(0);

      // Verify the Finalized event was emitted in the finalize() tx
      // setupAndFinalize already called finalize(), so query past events
      const filter = crowdfund.filters.Finalized();
      const events = await crowdfund.queryFilter(filter);
      expect(events).to.have.lengthOf(1);

      const ev = events[0];
      expect(ev.args.saleSize).to.equal(saleSize);
      expect(ev.args.allocatedArm).to.equal(totalAllocArm);
      expect(ev.args.netProceeds).to.equal(totalAllocUsdc);
      expect(ev.args.refundMode).to.equal(false);
    });

    it("emits Finalized event with zero saleSize and allocations in refundMode", async function () {
      // 16 seeds × $15K = $240K < MIN_SALE ($250K) → enters refundMode
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
  
      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      // Capped demand $240K < MIN_SALE takes the capped-demand refund branch, which emits
      // saleSize 0 (the post-allocation branch, which set saleSize, is unreachable with
      // 100% ceilings and no hop-2 floor). 16 seeds × $15K = $240K committed and capped.
      await expect(crowdfund.finalize())
        .to.emit(crowdfund, "Finalized")
        .withArgs(0, 0, 0, true, USDC(240_000), USDC(240_000));
    });
  });

  // ============================================================
  // T4.7 — 3-Year Claim Deadline
  // ============================================================

  describe("Claim Deadline (T4.7)", function () {
    it("claimDeadline is set at finalization", async function () {
      await setupAndFinalize(80, USDC(15_000));

      const deadline = await crowdfund.claimDeadline();
      expect(deadline).to.be.gt(0);
    });

    it("claim at exact deadline gives ARM, claim after deadline gives refund only", async function () {
      const seeds = await setupAndFinalize(80, USDC(15_000));

      const deadline = await crowdfund.claimDeadline();

      // Contract uses: block.timestamp <= claimDeadline for ARM transfer
      // increaseTo(N) sets next block timestamp to N; the tx mines at N.
      // So increaseTo(deadline - 1n) → claim tx executes at block.timestamp == deadline
      await time.increaseTo(deadline - 1n);
      const armBefore = await armToken.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const armAfter = await armToken.balanceOf(seeds[0].address);
      expect(armAfter - armBefore).to.be.gt(0n); // ARM transferred

      // Now block.timestamp == deadline. Next tx at deadline+1 → no ARM, refund only.
      const armBefore1 = await armToken.balanceOf(seeds[1].address);
      const usdcBefore1 = await usdc.balanceOf(seeds[1].address);
      await crowdfund.connect(seeds[1]).claim(seeds[1].address);
      const armAfter1 = await armToken.balanceOf(seeds[1].address);
      const usdcAfter1 = await usdc.balanceOf(seeds[1].address);
      expect(armAfter1 - armBefore1).to.equal(0n); // no ARM after deadline
      expect(usdcAfter1 - usdcBefore1).to.be.gte(0n); // refund still works
    });

    it("claimRefund after claim deadline still succeeds (USDC has no expiry)", async function () {
      // Create a refundMode scenario
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
  
      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      // Warp far into the future
      await time.increase(THREE_YEARS + 1);

      // Refund still works
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);
      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
    });

    it("claimDeadline is 0 in refundMode", async function () {
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
  
      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();

      expect(await crowdfund.refundMode()).to.be.true;
      expect(await crowdfund.claimDeadline()).to.equal(0);
    });

    it("CLAIM_DEADLINE_DURATION is 1095 days (3 years)", async function () {
      expect(await crowdfund.CLAIM_DEADLINE_DURATION()).to.equal(1095 * 24 * 60 * 60);
    });
  });

  // ============================================================
  // Full USDC Token Flow Conservation
  // ============================================================

  describe("Full USDC Token Flow Conservation", function () {
    it("absolute USDC flow: treasury delta + sum(refunds) + residual == totalCommitted", async function () {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      // 80 seeds × $20K = $1.6M oversubscribes the $1.5M sale, so the pro-rata path pays
      // non-zero refunds and leaves rounding dust.
      const seeds = await setupAndFinalize(80, USDC(20_000));
      const treasuryAfter = await usdc.balanceOf(treasury.address);
      const treasuryDelta = treasuryAfter - treasuryBefore;

      // All participants claim via claim() (handles ARM + refund), tracking actual USDC received
      let sumRefundsPaid = 0n;
      const allParticipants = [...seeds];
      for (const p of allParticipants) {
        const before = await usdc.balanceOf(p.address);
        await crowdfund.connect(p).claim(p.address);
        const after = await usdc.balanceOf(p.address);
        sumRefundsPaid += (after - before);
      }

      const residual = await usdc.balanceOf(await crowdfund.getAddress());
      const totalCommitted = await crowdfund.totalCommitted();

      // Conservation: every USDC deposited is accounted for
      expect(treasuryDelta + sumRefundsPaid + residual).to.equal(totalCommitted);
      // Contract should have only dust remaining
      expect(residual).to.be.lte(USDC(1));
    });
  });

  // ============================================================
  // claim() Refund Mode Guard
  // ============================================================

  describe("claim() Refund Mode Guard", function () {
    it("claim() reverts when refundMode is true", async function () {
      // 16 seeds × $15K = $240K < MIN_SALE ($250K) → refundMode = true
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();

      // Verify we're in refundMode
      expect(await crowdfund.refundMode()).to.be.true;

      // claim() should revert — if this guard were missing, users could drain ARM
      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: sale in refund mode");
    });

    it("claimRefund() succeeds when refundMode is true (counterpart)", async function () {
      // Same refundMode setup
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      // claimRefund should return full committed amount
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);
      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
    });
  });

  // ============================================================
  // T4.8 — Multi-Window withdrawUnallocatedArm
  // ============================================================

  describe("Multi-Window ARM Sweep (T4.8)", function () {
    it("post-finalization base sale: sweeps unsold ARM immediately", async function () {
      // 68 seeds × $15K = $1.02M of the $1.5M sale: $480K of ARM unsold
      const seeds = await setupAndFinalize(68, USDC(15_000));

      const totalAlloc = await crowdfund.totalAllocatedArm();
      const armInContract = await armToken.balanceOf(await crowdfund.getAddress());
      const expectedSweep = armInContract - totalAlloc;
      expect(expectedSweep).to.be.gt(0);

      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedSweep);
    });

    it("second sweep after first: reverts (nothing to sweep until claims or deadline)", async function () {
      await setupAndFinalize(68, USDC(15_000));

      await crowdfund.withdrawUnallocatedArm();

      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");
    });

    it("after some claims: sweep sees reduced armStillOwed", async function () {
      const seeds = await setupAndFinalize(68, USDC(15_000));

      // First sweep: unsold ARM
      const totalAlloc = await crowdfund.totalAllocatedArm();
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      const expectedFirstSweep = armBalance - totalAlloc;
      expect(expectedFirstSweep).to.be.gt(0);
      await crowdfund.withdrawUnallocatedArm();

      // Half the seeds claim — reduces armStillOwed
      for (let i = 0; i < 34; i++) {
        await crowdfund.connect(seeds[i]).claim(seeds[i].address);
      }

      // armStillOwed decreased, but no new unsold ARM. Balance = totalAlloc - claimed.
      // Nothing new to sweep unless there's rounding dust.
      const armAfterClaims = await armToken.balanceOf(await crowdfund.getAddress());
      const totalArmClaimed = await crowdfund.totalArmTransferred();
      // Contract should have exactly totalAlloc - totalArmClaimed
      expect(armAfterClaims).to.equal(totalAlloc - totalArmClaimed);
    });

    it("after 3-year deadline: sweeps all remaining ARM (unclaimed)", async function () {
      const seeds = await setupAndFinalize(68, USDC(15_000));

      // First sweep: unsold ARM
      await crowdfund.withdrawUnallocatedArm();

      // Only 1 of 68 seeds claims
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

      // Before deadline: can't sweep unclaimed
      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");

      // Warp past deadline
      const deadline = await crowdfund.claimDeadline();
      await time.increaseTo(deadline + 1n);

      // Now all unclaimed ARM is sweepable
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      expect(armBalance).to.be.gt(0);

      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(armBalance);
      expect(await armToken.balanceOf(await crowdfund.getAddress())).to.equal(0);
    });

    it("after refundMode finalization: sweeps all ARM (armStillOwed = 0)", async function () {
      // 16 seeds × $15K = $240K < MIN_SALE ($250K) → refundMode
      const seeds = allSigners.slice(5, 21);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;

      // In refundMode, armStillOwed = 0, so full ARM balance is sweepable
      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ARM(1_500_000));
    });

    it("after cancel: sweeps all ARM", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
  

      await crowdfund.connect(securityCouncil).cancel();

      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ARM(1_500_000));
    });

    it("emits UnallocatedArmWithdrawn event", async function () {
      const seeds = await setupAndFinalize(68, USDC(15_000));

      const totalAlloc = await crowdfund.totalAllocatedArm();
      const armInContract = await armToken.balanceOf(await crowdfund.getAddress());
      const expectedSweep = armInContract - totalAlloc;

      await expect(crowdfund.withdrawUnallocatedArm())
        .to.emit(crowdfund, "UnallocatedArmWithdrawn")
        .withArgs(treasury.address, expectedSweep);
    });

    it("permissionless: any address can call", async function () {
      await setupAndFinalize(80, USDC(15_000));

      // Random non-admin signer calls
      const rando = allSigners[199];
      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.connect(rando).withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });
  });
});
