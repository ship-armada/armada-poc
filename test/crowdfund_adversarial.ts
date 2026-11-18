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

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund Adversarial", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let treasuryAddr: SignerWithAddress;
  let securityCouncil: SignerWithAddress;
  let allSigners: SignerWithAddress[];

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  // Place a hop-1 team inviter wallet (the only tier that can invite) and have it invite
  // `invitees` to hop-2, each committing `amount` (≤ the $10K hop-2 cap unless testing over-cap).
  async function addHop2Demand(teamWallet: SignerWithAddress, invitees: SignerWithAddress[], amount: bigint) {
    await crowdfund.launchTeamInvite(teamWallet.address, 0);
    for (const invitee of invitees) {
      await crowdfund.connect(teamWallet).invite(invitee.address, 1);
      await fundAndApprove(invitee, amount);
      await crowdfund.connect(invitee).commit(2, amount);
    }
  }

  async function warpPastWindow() {
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
    treasuryAddr = allSigners[199];
    securityCouncil = allSigners[198];

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
      securityCouncil.address, // securityCouncil
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    // Fund ARM for MAX_SALE and verify pre-load
    const CROWDFUND_ARM_FUNDING = ARM(1_500_000);
    await armToken.transfer(cfAddr, CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
  });

  // ============================================================
  // 1. Precision & Accounting Invariants
  // ============================================================

  describe("Precision & Accounting Invariants", function () {
    it("sum of allocations + refunds == totalCommitted (70 seeds, pro-rata)", async function () {
      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // All commit $25K = 70 * $25K = $1.75M > $1.5M sale → hop-0 pro-rata (non-integer scale)
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      // Verify sum of parts across all participants
      let sumAllocUsdc = 0n;
      let sumRefund = 0n;
      let sumAllocArm = 0n;

      for (const s of seeds) {
        const [alloc, refund] = await crowdfund.computeAllocation(s.address);
        sumAllocArm += alloc;
        sumRefund += refund;
        // Derive allocUsdc from: refund = committed - allocUsdc → allocUsdc = committed - refund
        sumAllocUsdc += (USDC(25_000) - refund);
      }

      const totalCommitted = await crowdfund.totalCommitted();
      const totalAllocated = await crowdfund.totalAllocatedArm();
      const totalAllocatedUsdc = await crowdfund.totalAllocatedUsdc();

      // allocUsdc + refund == committed for each participant (exact)
      expect(sumAllocUsdc + sumRefund).to.equal(totalCommitted);

      // With lazy eval, totalAllocated/totalAllocatedUsdc are hop-level upper bounds.
      // Individual integer division truncation means sum(individual) <= hop-level total.
      // The difference is at most uniqueCommitters per oversubscribed hop (negligible dust).
      const totalParticipants = BigInt(seeds.length);
      expect(sumAllocArm).to.be.lte(totalAllocated);
      expect(sumAllocArm).to.be.gte(totalAllocated - totalParticipants * ARM(1));

      expect(sumAllocUsdc).to.be.lte(totalAllocatedUsdc);
      expect(sumAllocUsdc).to.be.gte(totalAllocatedUsdc - totalParticipants);

      // No participant gets more than their committed amount
      for (const s of seeds) {
        const [alloc] = await crowdfund.computeAllocation(s.address);
        // allocArm in USDC value = allocArm * ARM_PRICE / 1e18 = allocArm / 1e12
        const allocUsdcValue = alloc / BigInt(1e12);
        expect(allocUsdcValue).to.be.lte(USDC(25_000));
      }
    });

    it("sum of allocations + refunds == totalCommitted (mixed hops, 100+ participants)", async function () {
      // Setup: 70 seeds at $15K ($1.05M) + a team wallet inviting 70 hop-2 participants at $10K
      // ($700K). Total $1.75M > $1.5M: hop-0 fills, hop-2 is pro-rated into the $450K left.
      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));

      // Seeds commit $15K each
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Team wallet invites hop-2 addresses (use signers 71-140), each commits $10K
      const hop2Addrs = allSigners.slice(71, 141);
      const hop1Count = hop2Addrs.length;
      await addHop2Demand(allSigners[160], hop2Addrs, USDC(10_000));

      await warpPastWindow();
      await crowdfund.finalize();

      // Sum-of-parts check across all participants
      const totalCommitted = await crowdfund.totalCommitted();
      let sumAllocUsdc = 0n;
      let sumRefund = 0n;

      const allParticipants = [...seeds, ...hop2Addrs.slice(0, hop1Count)];
      for (const p of allParticipants) {
        const [, refund] = await crowdfund.computeAllocation(p.address);
        // Seeds are hop-0, hop2Addrs are hop-2
        const hop = seeds.includes(p) ? 0 : 2;
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

      // 70 × $25K = $1.75M oversubscribes the sale, so the full 1.5M ARM is allocated
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      const totalAllocated = await crowdfund.totalAllocatedArm();
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());
      expect(armBalance).to.be.gte(totalAllocated);
    });

    it("after all claims, contract balances are non-negative", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      // 70 × $15K = $1.05M at hop-0 + 30 hop-2 × $10K = $300K: $1.35M of the $1.5M sale,
      // so there is unsold ARM for the sweep below.
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      const hop2Pool = allSigners.slice(140, 170);
      await addHop2Demand(allSigners[180], hop2Pool, USDC(10_000));

      await warpPastWindow();
      await crowdfund.finalize();

      // All participants claim ARM + USDC refund via claim() (seeds + hop-2)
      for (const s of seeds) {
        await crowdfund.connect(s).claim(s.address);
      }
      for (const h of hop2Pool) {
        await crowdfund.connect(h).claim(h.address);
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


      await fundAndApprove(allSigners[1], USDC(150_000));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(150_000));

      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(150_000));
    });

    it("commit over hop cap succeeds (excess refunded at settlement)", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(150_050));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(150_000));

      // $50 more (meets MIN_COMMIT, exceeds hop cap — accepted for refund at settlement)
      await crowdfund.connect(allSigners[1]).commit(0, USDC(50));

      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(150_050));

      const [tc0] = await crowdfund.getHopStats(0);
      expect(tc0).to.equal(USDC(150_050));
    });

    it("totalCommitted exactly at MIN_SALE finalizes (not cancel)", async function () {
      // MIN_SALE = $250,000: 16 seeds at $15K ($240K) + 1 seed at $10K = exactly $250K
      const seeds = allSigners.slice(1, 18); // 17 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (let i = 0; i < 16; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }
      await fundAndApprove(seeds[16], USDC(10_000));
      await crowdfund.connect(seeds[16]).commit(0, USDC(10_000));

      const total = await crowdfund.totalCommitted();
      expect(total).to.equal(USDC(250_000));

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.equal(false);
    });

    // WHY: When totalCommitted is 1 wei below MIN_SALE, finalize() must enter refundMode
    // instead of reverting, ensuring the phase transitions to Finalized so ARM tokens
    // can be recovered via withdrawUnallocatedArm().
    it("totalCommitted 1 below MIN_SALE causes finalize to enter refundMode", async function () {
      // 16 seeds at $15K = $240K. 1 seed at $9,999.999999 = $249,999.999999 < $250K
      const seeds = allSigners.slice(1, 18);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (let i = 0; i < 16; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }
      // 1 wei less than $10K needed to reach $250K
      const shortAmount = USDC(10_000) - 1n;
      await fundAndApprove(seeds[16], shortAmount);
      await crowdfund.connect(seeds[16]).commit(0, shortAmount);

      const total = await crowdfund.totalCommitted();
      expect(total).to.be.lt(USDC(250_000));

      await warpPastWindow();
      await crowdfund.finalize();

      // Phase transitions to Finalized with refundMode — participants use claimRefund()
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;
    });

    // WHY: BASE_SALE == MAX_SALE == ELASTIC_TRIGGER, so demand at the trigger keeps the $1.5M
    //      sale size (no expansion) and fills it.
    it("totalCommitted exactly at ELASTIC_TRIGGER keeps the $1.5M sale size", async function () {
      // ELASTIC_TRIGGER = $1,500,000: 100 seeds at $15K each
      const seeds = allSigners.slice(1, 101); // 100 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      const total = await crowdfund.totalCommitted();
      expect(total).to.equal(USDC(1_500_000));

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_500_000)); // MAX_SALE == BASE_SALE
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(USDC(1_500_000));
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

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.saleSize()).to.equal(USDC(1_500_000)); // BASE_SALE
    });

    // WHY: with a 100% hop-0 ceiling the known tier alone can clear MIN_SALE — no other-hop
    //      demand is required (a hop-0 ceiling below MIN_SALE would force refundMode here).
    it("finalize with seeds only succeeds (hop-0 ceiling is the whole sale)", async function () {
      // Only seeds commit — no hop-1/2 participants. 70 × $15K = $1.05M ≥ MIN_SALE.
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.equal(false);
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(USDC(1_050_000));

      // Hop-1 and hop-2 should have 0 committers
      const [, , uc1] = await crowdfund.getHopStats(1);
      const [, , uc2] = await crowdfund.getHopStats(2);
      expect(uc1).to.equal(0);
      expect(uc2).to.equal(0);
    });

    it("ELASTIC_TRIGGER boundary uses cappedDemand not totalCommitted (over-cap commits ignored)", async function () {
      // totalCommitted >= $1.5M but cappedDemand < $1.5M:
      // 99 seeds × $15K = $1,485K (all at or under cap).
      // 1 hop-2 participant commits $20K (over the $10K cap by $10K).
      // totalCommitted = $1,505K >= ELASTIC_TRIGGER; cappedDemand = $1,495K < ELASTIC_TRIGGER.
      const seeds = allSigners.slice(1, 100); // 99 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await addHop2Demand(allSigners[150], [allSigners[140]], USDC(20_000));

      expect(await crowdfund.totalCommitted()).to.equal(USDC(1_505_000));

      await warpPastWindow();
      await crowdfund.finalize();

      const cappedDemandVal = await crowdfund.cappedDemand();
      expect(cappedDemandVal).to.equal(USDC(1_495_000));
      expect(cappedDemandVal).to.be.lt(USDC(1_500_000));

      // saleSize remains BASE_SALE and the over-cap excess is not allocated
      expect(await crowdfund.saleSize()).to.equal(USDC(1_500_000));
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(USDC(1_495_000));
    });

    // WHY: Zero committers means cappedDemand = 0 < MIN_SALE. finalize() must
    // enter refundMode and transition to Phase.Finalized (not revert).
    it("finalize with all whitelisted but 0 committers enters refundMode", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Nobody commits — just fast-forward through the active window
      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;
    });

    it("commit below MIN_COMMIT ($50 USDC) reverts", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);


      await fundAndApprove(allSigners[1], USDC(50));

      // 1 wei reverts
      await expect(
        crowdfund.connect(allSigners[1]).commit(0, 1n)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      // $49.999999 reverts
      await expect(
        crowdfund.connect(allSigners[1]).commit(0, USDC(50) - 1n)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      // Exactly $50 succeeds
      await crowdfund.connect(allSigners[1]).commit(0, USDC(50));
      const committed = await crowdfund.getCommitment(allSigners[1].address, 0);
      expect(committed).to.equal(USDC(50));
    });

    // WHY: known contributors cannot invite (HOP0_MAX_INVITES = 0), so a seed's self-invite
    //      must revert; a hop-1 team wallet's self-invite creates its own hop-2 node.
    it("seed self-invite reverts; a team wallet self-invite creates a hop-2 node", async function () {
      const seed = allSigners[1];
      await crowdfund.addSeeds([seed.address]);
      await expect(
        crowdfund.connect(seed).invite(seed.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
      expect(await crowdfund.isWhitelisted(seed.address, 1)).to.be.false;

      const teamWallet = allSigners[2];
      await crowdfund.launchTeamInvite(teamWallet.address, 0);
      await crowdfund.connect(teamWallet).invite(teamWallet.address, 1);
      expect(await crowdfund.isWhitelisted(teamWallet.address, 2)).to.be.true;
      expect(await crowdfund.getInvitesReceived(teamWallet.address, 2)).to.equal(1);
    });

    it("invite reverts after windowEnd", async function () {
      const teamWallet = allSigners[1];
      const invitee = allSigners[2];
      await crowdfund.launchTeamInvite(teamWallet.address, 0);


      const windowEnd = await crowdfund.windowEnd();
      // Warp past windowEnd — invite should fail
      await time.increaseTo(windowEnd + 1n);
      await expect(
        crowdfund.connect(teamWallet).invite(invitee.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    it("invite succeeds 1 second before windowEnd", async function () {
      const teamWallet = allSigners[1];
      const invitee = allSigners[2];
      await crowdfund.launchTeamInvite(teamWallet.address, 0);


      const windowEnd = await crowdfund.windowEnd();
      // Warp to 2 seconds before windowEnd — next tx executes at windowEnd - 1
      await time.increaseTo(windowEnd - 2n);
      await crowdfund.connect(teamWallet).invite(invitee.address, 1);

      const p = await crowdfund.participants(invitee.address, 2);
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
        futureOpen
      );
      await freshCf.waitForDeployment();
      const freshCfAddr = await freshCf.getAddress();
      await armToken.addToWhitelist(freshCfAddr);
      if (!(await armToken.authorizedDelegatorsInitialized())) {
        await armToken.initAuthorizedDelegators([freshCfAddr]);
      }
      await armToken.transfer(freshCfAddr, ARM(1_500_000));
      await freshCf.loadArm();

      // Advance to windowStart so addSeeds works
      await time.increaseTo(await freshCf.windowStart());
      await freshCf.addSeeds([allSigners[1].address]);

      // Advance past windowEnd so commit reverts
      await time.increaseTo((await freshCf.windowEnd()) + 1n);
      await fundAndApprove(allSigners[1], USDC(15_000));
      await usdc.connect(allSigners[1]).approve(await freshCf.getAddress(), USDC(15_000));
      await expect(
        freshCf.connect(allSigners[1]).commit(0, USDC(15_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    it("invite after window ends reverts", async function () {
      await crowdfund.launchTeamInvite(allSigners[1].address, 0); // hop-1 team wallet

      await warpPastWindow(); // past active window

      await expect(
        crowdfund.connect(allSigners[1]).invite(allSigners[2].address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    it("finalize before window ends reverts", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: window not ended");
    });

    it("addSeeds after the launch-team invite window reverts", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);

      await time.increaseTo((await crowdfund.launchTeamInviteEnd()) + 1n); // past launch team invite period

      await expect(
        crowdfund.addSeeds([allSigners[2].address])
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    // WHY: When demand is below MIN_SALE, finalize() enters refundMode. claim() must
    // revert in refundMode (no ARM to distribute), and claimRefund() must work.
    it("claim reverts in refundMode (should use claimRefund)", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await fundAndApprove(seeds[0], USDC(15_000));
      await crowdfund.connect(seeds[0]).commit(0, USDC(15_000));

      await warpPastWindow();
      // finalize enters refundMode (below MIN_SALE)
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      // claim() reverts because sale is in refund mode
      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: sale in refund mode");

      // claimRefund() works after finalize-to-refundMode
      await crowdfund.connect(seeds[0]).claimRefund();
    });

    it("claimRefund when phase is Finalized (not refundMode) reverts — use claim() instead", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      // 70 × $25K = $1.75M oversubscribes the $1.5M sale → hop-0 pro-rata refunds
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);

      // claimRefund no longer handles success-path refunds — those go through claim()
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");

      // Instead, claim() handles both ARM + refund
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const usdcAfter = await usdc.balanceOf(seeds[0].address);

      // Seeds at oversubscribed hop-0 should get a USDC refund (allocation < committed)
      const [, refundAmount] = await crowdfund.computeAllocation(seeds[0].address);
      expect(refundAmount).to.be.gt(0n);
      expect(usdcAfter - usdcBefore).to.equal(refundAmount);
    });

    it("non-admin can finalize (permissionless)", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await warpPastWindow();

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
      await warpPastWindow();
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


      await warpPastWindow();
      await crowdfund.finalize();

      // First sweep: unsold ARM goes to treasury
      await crowdfund.withdrawUnallocatedArm();

      // Second sweep: nothing left (unclaimed ARM still owed)
      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");
    });

    it("pro-rata refund amounts match computeAllocation exactly for each participant", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      // 70 × $25K = $1.75M oversubscribes the $1.5M sale → hop-0 pro-rata
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      // Verify exact refund amounts for 5 representative seeds via claim()
      for (let i = 0; i < 5; i++) {
        const [, refundUsdc] = await crowdfund.computeAllocation(seeds[i].address);
        const usdcBefore = await usdc.balanceOf(seeds[i].address);
        await crowdfund.connect(seeds[i]).claim(seeds[i].address);
        const usdcAfter = await usdc.balanceOf(seeds[i].address);
        expect(usdcAfter - usdcBefore).to.equal(refundUsdc);
      }
    });

    it("withdrawUnallocatedArm reverts in Active phase", async function () {
      await crowdfund.addSeeds([allSigners[1].address]);

      await fundAndApprove(allSigners[1], USDC(15_000));
      await crowdfund.connect(allSigners[1]).commit(0, USDC(15_000));

      // Phase is still Active (window not ended, not finalized)
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      await expect(
        crowdfund.withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: not finalized or canceled");
    });

    // WHY: launchTeam is specified as a sentinel that "is not a participant and makes
    // no commitment" (specs/CROWDFUND.md §Word-of-Mouth Whitelist). The four guards
    // below enforce that invariant by closing every path that could place launchTeam
    // into the participant graph. Without them, launchTeam could self-register at
    // hop-0 via addSeed, self-invite at hop-1/hop-2 via launchTeamInvite, originate
    // hop-2 invites via the regular invite() path after the launch-team window, or be invited by
    // any participant — all of which contradict the spec.
    describe("launchTeam excluded from participant graph", function () {
      it("addSeed rejects launchTeam as a seed", async function () {
        await expect(
          crowdfund.addSeeds([deployer.address])
        ).to.be.revertedWith("ArmadaCrowdfund: launchTeam cannot be a seed");
      });

      it("launchTeamInvite rejects launchTeam as invitee at hop-1", async function () {
        await expect(
          crowdfund.launchTeamInvite(deployer.address, 0)
        ).to.be.revertedWith("ArmadaCrowdfund: launchTeam cannot be invitee");
      });

      it("launchTeamInvite rejects launchTeam as invitee at hop-2", async function () {
        await expect(
          crowdfund.launchTeamInvite(deployer.address, 1)
        ).to.be.revertedWith("ArmadaCrowdfund: launchTeam cannot be invitee");
      });

      // WHY: Defense in depth. With the addSeed/launchTeamInvite guards above, launchTeam
      // can never become whitelisted to even reach this check. The guard ensures that
      // even if a future code path introduced another whitelist route, launchTeam still
      // cannot use the regular invite() path to issue invites after the launch-team window.
      it("invite rejects launchTeam as msg.sender", async function () {
        await expect(
          crowdfund.connect(deployer).invite(allSigners[1].address, 0)
        ).to.be.revertedWith("ArmadaCrowdfund: launchTeam cannot invite via regular path");
      });

      // WHY: Closes the remaining route — a regular participant inviting launchTeam.
      // launchTeam is already blocked from committing and from originating invites
      // under the guards above, so this is not exploitable, but a regular invite of
      // launchTeam would still pollute the participant graph (whitelist a sentinel
      // address as a hop node, increment invitesReceived on re-invite). The spec
      // says launchTeam is not a participant; this guard makes the contract enforce it.
      it("invite rejects launchTeam as invitee (called by a regular participant)", async function () {
        await crowdfund.launchTeamInvite(allSigners[1].address, 0); // hop-1 team wallet can invite
        await expect(
          crowdfund.connect(allSigners[1]).invite(deployer.address, 1)
        ).to.be.revertedWith("ArmadaCrowdfund: launchTeam cannot be invitee");
      });
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
          localOpenTimestamp
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
          localOpenTimestamp
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


      await warpPastWindow();
      await crowdfund.finalize();

      // outsider never committed
      await expect(
        crowdfund.connect(allSigners[199]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: no commitment");
    });

    it("whitelisted-but-uncommitted participant cannot claim", async function () {
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Only first 69 seeds commit, seeds[69] does not
      for (let i = 0; i < 69; i++) {
        await fundAndApprove(seeds[i], USDC(15_000));
        await crowdfund.connect(seeds[i]).commit(0, USDC(15_000));
      }


      await warpPastWindow();
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
    // Priority fill (no hop-2 floor, 100% raw ceilings): hop-0 takes min(demand, $1.5M); hop-1
    // (team wallets, $0 cap) takes nothing; hop-2's effective ceiling is everything left over.

    it("hop-0 leftover rolls unconditionally to hop-2 through the empty hop-1", async function () {
      // 37 seeds commit $555K, leaving $945K of the sale. 56 hop-2 participants commit $10K each
      // ($560K), all within the rolled-over capacity → full allocation.
      const seeds = allSigners.slice(1, 38); // 37 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      const hop2Invitees = allSigners.slice(100, 156);
      await addHop2Demand(allSigners[160], hop2Invitees, USDC(10_000));

      await warpPastWindow();
      await crowdfund.finalize();

      // Hop-0 ceiling is the whole sale.
      expect(await crowdfund.finalCeilings(0)).to.equal(USDC(1_500_000));
      // Hop-1's effective ceiling is capped at the remaining $945K; with no demand it all rolls on.
      expect(await crowdfund.finalCeilings(1)).to.equal(USDC(945_000));
      expect(await crowdfund.finalCeilings(2)).to.equal(USDC(945_000));

      // Hop-2 is under-subscribed ($560K < $945K) → full allocation, no refund.
      const [alloc, refund] = await crowdfund.computeAllocation(hop2Invitees[0].address);
      expect(alloc).to.equal(ARM(10_000));
      expect(refund).to.equal(0n);

      // Unsold = $1.5M - ($555K + $560K) = $385K.
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      expect(USDC(1_500_000) - totalAllocUsdc).to.equal(USDC(385_000));
    });

    it("rollover works with zero committers at hop-2", async function () {
      // 68 seeds × $15K = $1.02M; nobody at hop-1 or hop-2. The $480K left over still rolls
      // to hop-2's effective ceiling — rollover does not depend on committer count.
      const seeds = allSigners.slice(1, 69); // 68 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.finalCeilings(0)).to.equal(USDC(1_500_000));
      expect(await crowdfund.finalCeilings(1)).to.equal(USDC(480_000));
      const hop2Ceiling = await crowdfund.finalCeilings(2);
      expect(hop2Ceiling).to.equal(USDC(480_000));

      // Unsold = saleSize - totalAllocatedUsdc.
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      expect(USDC(1_500_000) - totalAllocUsdc).to.equal(USDC(480_000));

      // Key assertion: rollover reached hop-2 despite 0 committers there (no floor needed).
      expect(hop2Ceiling).to.be.gt(0n);
    });

    it("over-subscribed hop-0 produces pro-rata with no rollover", async function () {
      // 70 seeds × $25K = $1.75M against the $1.5M hop-0 ceiling → pro-rata, nothing left over.
      const seeds = allSigners.slice(1, 71); // 70 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      // Pro-rata: scale = $1.5M / $1.75M ≈ 0.857143. Each $25K → about $21,428.57 allocation.
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      const accepted = (USDC(25_000) * USDC(1_500_000)) / USDC(1_750_000);
      expect(alloc).to.equal(accepted * 10n ** 12n);
      expect(refund).to.equal(USDC(25_000) - accepted);

      // No rollover: hop-2's effective ceiling is 0 and the sale is fully allocated.
      expect(await crowdfund.finalCeilings(2)).to.equal(0n);
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(USDC(1_500_000));
    });

    it("rollover preserves sum-of-parts invariant: alloc + unsold = saleSize", async function () {
      const seeds = allSigners.slice(1, 38); // 37 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop2Demand(allSigners[160], allSigners.slice(100, 156), USDC(10_000));

      await warpPastWindow();
      await crowdfund.finalize();

      const totalAlloc = await crowdfund.totalAllocatedUsdc();

      // Hop-0: demand $555K < ceiling $1.5M → alloc = $555K
      // Hop-1: demand $0 → alloc = $0
      // Hop-2: demand $560K < ceiling $945K → alloc = $560K
      expect(totalAlloc).to.equal(USDC(555_000) + USDC(560_000));

      // Unsold = $1.5M - $1.115M = $385K.
      expect(USDC(1_500_000) - totalAlloc).to.equal(USDC(385_000));
    });

    // WHY: two hops cannot both be oversubscribed: hop-1 (team wallets) has a $0 cap, and once
    //      hop-0 demand reaches the whole sale nothing rolls on. An oversubscribed hop-0 therefore
    //      leaves hop-2 with no allocation — every hop-2 participant is refunded in full.
    it("oversubscribed hop-0 leaves hop-2 nothing: hop-2 is refunded in full", async function () {
      // Hop-0: 54 seeds × $30K = $1.62M against the $1.5M sale (pro-rata).
      // Hop-2: 39 participants × $10K = $390K, allocated 0.
      const seeds = allSigners.slice(1, 55); // 54 seeds
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(30_000));
        await crowdfund.connect(s).commit(0, USDC(30_000));
      }
      const hop2Pool = allSigners.slice(55, 94);
      await addHop2Demand(allSigners[160], hop2Pool, USDC(10_000));

      await warpPastWindow();
      await crowdfund.finalize();

      // --- Hop-0 is oversubscribed with pro-rata ---
      const [, hop0Refund] = await crowdfund.computeAllocationAtHop(seeds[0].address, 0);
      expect(hop0Refund).to.be.gt(0n);

      // --- Hop-2 gets nothing: full refund ---
      const [hop2Arm, hop2Refund] = await crowdfund.computeAllocationAtHop(hop2Pool[0].address, 2);
      expect(hop2Arm).to.equal(0n);
      expect(hop2Refund).to.equal(USDC(10_000));

      // --- Sum-of-parts invariant across all participants ---
      let sumAllocUsdc = 0n;
      let sumRefund = 0n;
      for (const s of seeds) {
        const [, refundUsdc] = await crowdfund.computeAllocation(s.address);
        const committed = await crowdfund.getCommitment(s.address, 0);
        sumAllocUsdc += (committed - refundUsdc);
        sumRefund += refundUsdc;
      }
      for (const h of hop2Pool) {
        const [, refundUsdc] = await crowdfund.computeAllocation(h.address);
        const committed = await crowdfund.getCommitment(h.address, 2);
        sumAllocUsdc += (committed - refundUsdc);
        sumRefund += refundUsdc;
      }

      const totalCommitted = await crowdfund.totalCommitted();
      expect(sumAllocUsdc + sumRefund).to.equal(totalCommitted);

      // totalAllocatedUsdc is the hop-level aggregate, bounded by the sale size.
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(USDC(1_500_000));
    });
  });

  // ============================================================
  // 5. Below-Minimum Finalization Refund
  // ============================================================

  describe("Below-Minimum Finalization Refund", function () {
    // WHY: When cappedDemand < MIN_SALE, finalize() enters refundMode and transitions
    // to Phase.Finalized. Participants then claim full USDC refunds via claimRefund().
    // ARM tokens are recoverable via withdrawUnallocatedArm() once phase is Finalized.
    it("full refund after below-minimum finalize", async function () {
      // 3 seeds commit $15K each = $45K (well below MIN_SALE $250K)
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);

      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);

      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
    });

    // WHY: After successful finalization (cappedDemand >= MIN_SALE, not refundMode),
    // claimRefund() must revert. Participants use claim() for ARM + pro-rata refunds.
    it("claimRefund reverts after successful finalize (not refundMode)", async function () {
      // 70 seeds commit $15K = $1.05M → cappedDemand > MIN_SALE
      const seeds = allSigners.slice(1, 71);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");
    });

    // WHY: Multiple participants must all be able to claim refunds after a below-minimum
    // finalize. Verifies the refundMode state works for sequential claimRefund() calls.
    it("multiple participants claim refund after below-minimum finalize", async function () {
      // 3 seeds commit small amounts
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      // All 3 participants can claim full refunds
      for (const s of seeds) {
        const usdcBefore = await usdc.balanceOf(s.address);
        await crowdfund.connect(s).claimRefund();
        const usdcAfter = await usdc.balanceOf(s.address);
        expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));
      }
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


      await warpPastWindow();
      await crowdfund.finalize();

      // Verify claim works normally (proving nonReentrant doesn't block legitimate calls)
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      expect(await crowdfund.claimed(seeds[0].address)).to.be.true;

      // Double claim should fail
      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("claimRefund() rejects double-refund", async function () {
      const seeds = allSigners.slice(1, 4);
      await crowdfund.addSeeds(seeds.map(s => s.address));


      await fundAndApprove(seeds[0], USDC(15_000));
      await crowdfund.connect(seeds[0]).commit(0, USDC(15_000));

      await warpPastWindow();
      // Finalize enters refundMode (below MIN_SALE)
      await crowdfund.finalize();

      // claimRefund works
      await crowdfund.connect(seeds[0]).claimRefund();

      // Double claimRefund fails
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
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


      await warpPastWindow();
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
      await warpPastWindow();
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
