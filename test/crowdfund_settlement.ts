// ABOUTME: Tests for crowdfund settlement: security council cancel, proceeds push,
// ABOUTME: claim deadline, and multi-window ARM sweep.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Setup: 0, Active: 1, Finalized: 2, Canceled: 3 };

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const THREE_WEEKS = 21 * 24 * 60 * 60;
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
  // Always adds hop-1 demand to ensure totalAllocUsdc > MIN_SALE (avoids refundMode).
  async function setupAndFinalize(seedCount: number, commitUsdc: bigint) {
    const seeds = allSigners.slice(5, 5 + seedCount);
    for (const s of seeds) {
      await fundAndApprove(s, commitUsdc);
    }
    await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
    await crowdfund.startWindow();
    for (const s of seeds) {
      await crowdfund.connect(s).commit(commitUsdc, 0);
    }

    // Add hop-1 demand to ensure net proceeds > MIN_SALE.
    // Hop-0 ceiling at BASE_SALE ≈ $798K, so we need ~$210K+ from hop-1.
    const hop1Pool = allSigners.slice(140, 195);
    const inviterCount = Math.min(seeds.length, 18); // 18 × 3 = 54 hop-1 × $4K = $216K
    for (let i = 0; i < inviterCount; i++) {
      for (let j = 0; j < 3 && (i * 3 + j) < hop1Pool.length; j++) {
        const hop1Idx = i * 3 + j;
        await crowdfund.connect(seeds[i]).invite(hop1Pool[hop1Idx].address, 0);
        await fundAndApprove(hop1Pool[hop1Idx], USDC(4_000));
        await crowdfund.connect(hop1Pool[hop1Idx]).commit(USDC(4_000), 1);
      }
    }

    await time.increase(THREE_WEEKS + 1);
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
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      deployer.address,
      treasury.address,
      deployer.address,         // launchTeam
      securityCouncil.address   // securityCouncil
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());

    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();
  });

  // ============================================================
  // T4.5 — Security Council cancel()
  // ============================================================

  describe("Security Council Cancel (T4.5)", function () {
    it("security council can cancel during Setup phase", async function () {
      expect(await crowdfund.phase()).to.equal(Phase.Setup);
      await crowdfund.connect(securityCouncil).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);
    });

    it("security council can cancel during Active phase", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      await crowdfund.connect(securityCouncil).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);
    });

    it("security council can cancel after window but before finalize", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();
      await time.increase(THREE_WEEKS + 1);

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
      await crowdfund.startWindow();
      await fundAndApprove(allSigners[5], USDC(15_000));

      await crowdfund.connect(securityCouncil).cancel();

      await expect(
        crowdfund.connect(allSigners[5]).commit(USDC(10_000), 0)
      ).to.be.revertedWith("ArmadaCrowdfund: not active");
    });

    it("after cancel: finalize reverts", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();
      await time.increase(THREE_WEEKS + 1);

      await crowdfund.connect(securityCouncil).cancel();

      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: already finalized");
    });

    it("after cancel: claimRefund works", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(USDC(10_000), 0);

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

      expect(treasuryAfter - treasuryBefore).to.equal(ARM(1_800_000));
    });

    it("emits SaleCanceled event", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(USDC(10_000), 0);

      await expect(crowdfund.connect(securityCouncil).cancel())
        .to.emit(crowdfund, "SaleCanceled")
        .withArgs(USDC(10_000));
    });

    it("securityCouncil immutable is set correctly", async function () {
      expect(await crowdfund.securityCouncil()).to.equal(securityCouncil.address);
    });

    it("claimRefund reverts for whitelisted address with zero commitment", async function () {
      await crowdfund.addSeeds([allSigners[5].address, allSigners[6].address]);
      await crowdfund.startWindow();
      // allSigners[5] commits, allSigners[6] does not
      await fundAndApprove(allSigners[5], USDC(10_000));
      await crowdfund.connect(allSigners[5]).commit(USDC(10_000), 0);

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

    it("all participants can still claim after proceeds push", async function () {
      const seeds = await setupAndFinalize(80, USDC(15_000));

      // All seeds claim
      for (const s of seeds) {
        await crowdfund.connect(s).claim();
      }

      // Contract should have minimal USDC left (dust from rounding)
      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      expect(contractUsdc).to.be.lte(USDC(1));
    });

    it("refundMode does NOT push proceeds (no proceeds to push)", async function () {
      // 80 seeds at hop-0 only → enters refundMode (hop-0 ceiling < MIN_SALE)
      const seeds = allSigners.slice(5, 85);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
      await crowdfund.startWindow();
      for (const s of seeds) {
        await crowdfund.connect(s).commit(USDC(15_000), 0);
      }
      await time.increase(THREE_WEEKS + 1);

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await crowdfund.finalize();
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      expect(await crowdfund.refundMode()).to.be.true;
      // No USDC pushed in refundMode
      expect(treasuryAfter - treasuryBefore).to.equal(0);
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

    it("claim just before deadline succeeds", async function () {
      const seeds = await setupAndFinalize(80, USDC(15_000));

      const deadline = await crowdfund.claimDeadline();
      // increaseTo sets next block timestamp; claim tx executes in the block after that
      await time.increaseTo(deadline - 2n);

      // Should succeed (block.timestamp <= claimDeadline)
      await crowdfund.connect(seeds[0]).claim();
    });

    it("claim after deadline reverts", async function () {
      const seeds = await setupAndFinalize(80, USDC(15_000));

      const deadline = await crowdfund.claimDeadline();
      await time.increaseTo(deadline);

      await expect(
        crowdfund.connect(seeds[0]).claim()
      ).to.be.revertedWith("ArmadaCrowdfund: claim deadline passed");
    });

    it("claimRefund after claim deadline still succeeds (USDC has no expiry)", async function () {
      // Create a refundMode scenario
      const seeds = allSigners.slice(5, 85);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
      await crowdfund.startWindow();
      for (const s of seeds) {
        await crowdfund.connect(s).commit(USDC(15_000), 0);
      }
      await time.increase(THREE_WEEKS + 1);
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
      const seeds = allSigners.slice(5, 85);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));
      await crowdfund.startWindow();
      for (const s of seeds) {
        await crowdfund.connect(s).commit(USDC(15_000), 0);
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.refundMode()).to.be.true;
      expect(await crowdfund.claimDeadline()).to.equal(0);
    });

    it("CLAIM_DEADLINE_DURATION is 1095 days (3 years)", async function () {
      expect(await crowdfund.CLAIM_DEADLINE_DURATION()).to.equal(1095 * 24 * 60 * 60);
    });
  });

  // ============================================================
  // T4.8 — Multi-Window withdrawUnallocatedArm
  // ============================================================

  describe("Multi-Window ARM Sweep (T4.8)", function () {
    it("post-finalization base sale: sweeps unsold ARM immediately", async function () {
      // 68 seeds × $15K = $1.02M at BASE_SALE
      const seeds = await setupAndFinalize(68, USDC(15_000));

      const totalAlloc = await crowdfund.totalAllocated();
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
      const totalAlloc = await crowdfund.totalAllocated();
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      const expectedFirstSweep = armBalance - totalAlloc;
      expect(expectedFirstSweep).to.be.gt(0);
      await crowdfund.withdrawUnallocatedArm();

      // Half the seeds claim — reduces armStillOwed
      for (let i = 0; i < 34; i++) {
        await crowdfund.connect(seeds[i]).claim();
      }

      // armStillOwed decreased, but no new unsold ARM. Balance = totalAlloc - claimed.
      // Nothing new to sweep unless there's rounding dust.
      const armAfterClaims = await armToken.balanceOf(await crowdfund.getAddress());
      const totalArmClaimed = await crowdfund.totalArmClaimed();
      // Contract should have exactly totalAlloc - totalArmClaimed
      expect(armAfterClaims).to.equal(totalAlloc - totalArmClaimed);
    });

    it("after 3-year deadline: sweeps all remaining ARM (unclaimed)", async function () {
      const seeds = await setupAndFinalize(68, USDC(15_000));

      // First sweep: unsold ARM
      await crowdfund.withdrawUnallocatedArm();

      // Only 1 of 68 seeds claims
      await crowdfund.connect(seeds[0]).claim();

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

    it("after cancel: sweeps all ARM", async function () {
      await crowdfund.addSeeds([allSigners[5].address]);
      await crowdfund.startWindow();

      await crowdfund.connect(securityCouncil).cancel();

      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(ARM(1_800_000));
    });

    it("emits UnallocatedArmWithdrawn event", async function () {
      const seeds = await setupAndFinalize(68, USDC(15_000));

      const totalAlloc = await crowdfund.totalAllocated();
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
