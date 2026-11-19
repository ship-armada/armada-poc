// ABOUTME: Comprehensive end-to-end lifecycle tests for ArmadaCrowdfund.
// ABOUTME: Exercises all lifecycle paths with conservation invariant verification.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ============ Constants ============

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

const ONE_DAY = 86400;
const THREE_YEARS = 1095 * ONE_DAY;

// Relaunch sale: BASE_SALE == MAX_SALE == ELASTIC_TRIGGER ($1.8M), so there is no expansion.
const BASE_SALE = USDC(1_800_000);
const MAX_SALE = USDC(1_800_000);
const MIN_SALE = USDC(250_000);
const ELASTIC_TRIGGER = USDC(1_800_000);
const TEAM_PAYMENT = USDC(250_000);
const MAX_SALE_ARM = ARM(1_800_000);

// EIP-712 types for invite signatures
const INVITE_TYPES = {
  Invite: [
    { name: "inviter", type: "address" },
    { name: "fromHop", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// ============ Helpers ============

/** Parse named events from a transaction receipt */
function parseEvents(crowdfund: any, receipt: any, eventName: string): any[] {
  return receipt.logs
    .filter((l: any) => {
      try {
        return crowdfund.interface.parseLog(l)?.name === eventName;
      } catch {
        return false;
      }
    })
    .map((l: any) => crowdfund.interface.parseLog(l));
}

describe("Crowdfund Full Lifecycle", function () {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let securityCouncil: HardhatEthersSigner;
  let randomCaller: HardhatEthersSigner;
  let allSigners: HardhatEthersSigner[];
  let usdc: any;
  let armToken: any;

  async function fundAndApprove(
    signer: HardhatEthersSigner,
    amount: bigint,
    cf: any
  ) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await cf.getAddress(), amount);
  }

  async function deployCrowdfund() {
    const ArmadaCrowdfund =
      await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    const crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address, // launchTeam
      securityCouncil.address,
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);
    await armToken.transfer(cfAddr, ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
    return crowdfund;
  }

  function buildDomain(contractAddress: string) {
    return {
      name: "ArmadaCrowdfund",
      version: "1",
      chainId: 31337,
      verifyingContract: contractAddress,
    };
  }

  async function signInvite(
    signer: HardhatEthersSigner,
    fromHop: number,
    nonce: number,
    deadline: number,
    domain: any
  ): Promise<string> {
    return signer.signTypedData(domain, INVITE_TYPES, {
      inviter: signer.address,
      fromHop,
      nonce,
      deadline,
    });
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    deployer = allSigners[0];
    treasury = allSigners[1];
    securityCouncil = allSigners[2];
    randomCaller = allSigners[4];

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([deployer.address]);
  });

  // ================================================================
  // Path 1: Successful Finalization (base sale) — full spec exercise
  // ================================================================

  describe("Path 1: Successful Finalization (base sale)", function () {
    // WHY: one sale that exercises every relaunch feature end to end — launch-team placements
    // (the team wallet at hop-1, a hop-2 placement), team-wallet peer invites and invite links
    // into hop-2, hop-2 stacking across invite sources, nonce revocation, an over-cap deposit, a
    // team-wallet commit (excluded at its $0 cap), hop-2 priority, the launch-team payment, lazy
    // claims, the ARM sweep, and the conservation invariants. Demand is sized so the hop-2 tier
    // ($122K, inside its $300K reserve) fills in full first and the known tier ($1.825M capped)
    // is pro-rated into the $1.678M left of the $1.8M sale.
    it("complete lifecycle with all spec features", async function () {
      const crowdfund = await deployCrowdfund();
      const cfAddr = await crowdfund.getAddress();
      const domain = buildDomain(cfAddr);

      // ---- Verify ArmLoaded ----
      expect(await crowdfund.armLoaded()).to.be.true;

      // ---- Setup: Add 70 seeds (known contributors) ----
      const seeds = allSigners.slice(5, 75); // 70 seeds
      const addSeedsTx = await crowdfund.addSeeds(
        seeds.map((s) => s.address)
      );
      const addSeedsReceipt = await addSeedsTx.wait();
      const seedEvents = parseEvents(crowdfund, addSeedsReceipt, "SeedAdded");
      expect(seedEvents.length).to.equal(70);

      // deployCrowdfund() already advances to windowStart

      // ---- Launch team placements ----
      // The single hop-1 team inviter wallet (LAUNCH_TEAM_HOP1_BUDGET = 1)
      const teamWallet = allSigners[198];
      {
        const tx = await crowdfund.launchTeamInvite(teamWallet.address, 0);
        await expect(tx)
          .to.emit(crowdfund, "LaunchTeamInvited")
          .withArgs(teamWallet.address, 1);
      }

      // 1 direct hop-2 ($10K slot) placement
      const ltHop2 = allSigners.slice(199, 200);
      {
        const tx = await crowdfund.launchTeamInvite(ltHop2[0].address, 1);
        await expect(tx)
          .to.emit(crowdfund, "LaunchTeamInvited")
          .withArgs(ltHop2[0].address, 2);
      }

      // Verify budget tracking
      const [budgetHop1Left, budgetHop2Left] =
        await crowdfund.getLaunchTeamBudgetRemaining();
      expect(budgetHop1Left).to.equal(1 - 1); // 1 used
      expect(budgetHop2Left).to.equal(500 - 1); // 1 used

      // ---- Peer invites: the team wallet invites 10 hop-2 contributors ----
      const hop2Pool = allSigners.slice(105, 115);
      const hop2Invitees: HardhatEthersSigner[] = [];
      for (const invitee of hop2Pool) {
        const tx = await crowdfund
          .connect(teamWallet)
          .invite(invitee.address, 1);
        await expect(tx)
          .to.emit(crowdfund, "Invited")
          .withArgs(teamWallet.address, invitee.address, 2, 0);
        hop2Invitees.push(invitee);
      }

      // ---- Hop-2 stacking: the team wallet also invites the launch-team placement ----
      // Invites stack at hop-2 regardless of source: 2 slots → $20K cap.
      await crowdfund.connect(teamWallet).invite(ltHop2[0].address, 1);
      expect((await crowdfund.participants(ltHop2[0].address, 2)).invitesReceived).to.equal(2);

      // ---- EIP-712 invite link: the team wallet signs a hop-2 link ----
      const linkInviter = teamWallet;
      const linkInvitee = allSigners[115];
      const linkNonce = 1;
      const linkDeadline = Number(await crowdfund.windowEnd());
      const signature = await signInvite(
        linkInviter,
        1,
        linkNonce,
        linkDeadline,
        domain
      );

      // Fund the invitee and redeem via commitWithInvite
      await fundAndApprove(linkInvitee, USDC(10_000), crowdfund);
      const commitWithInviteTx = await crowdfund
        .connect(linkInvitee)
        .commitWithInvite(
          linkInviter.address,
          1,
          linkNonce,
          linkDeadline,
          signature,
          USDC(2_000)
        );
      await expect(commitWithInviteTx)
        .to.emit(crowdfund, "Invited")
        .withArgs(linkInviter.address, linkInvitee.address, 2, linkNonce);
      await expect(commitWithInviteTx)
        .to.emit(crowdfund, "Committed")
        .withArgs(linkInvitee.address, 2, USDC(2_000));

      // ---- Revoke nonce 2 from the same inviter, verify it blocks redemption ----
      const revokeTx = await crowdfund
        .connect(linkInviter)
        .revokeInviteNonce(2);
      await expect(revokeTx)
        .to.emit(crowdfund, "InviteNonceRevoked")
        .withArgs(linkInviter.address, 2);

      // Try to use revoked nonce — should revert
      const linkInvitee2 = allSigners[116];
      await fundAndApprove(linkInvitee2, USDC(10_000), crowdfund);
      const revokedSig = await signInvite(
        linkInviter,
        1,
        2,
        linkDeadline,
        domain
      );
      await expect(
        crowdfund
          .connect(linkInvitee2)
          .commitWithInvite(
            linkInviter.address,
            1,
            2,
            linkDeadline,
            revokedSig,
            USDC(1_000)
          )
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");

      // ---- Commitments: seeds[1..69] commit $25K at hop-0 ----
      for (const s of seeds.slice(1)) {
        await fundAndApprove(s, USDC(25_000), crowdfund);
        const tx = await crowdfund.connect(s).commit(0, USDC(25_000));
        await expect(tx)
          .to.emit(crowdfund, "Committed")
          .withArgs(s.address, 0, USDC(25_000));
      }

      // ---- Over-cap deposit: seed[0] commits $100K then another $5K (total $105K > $100K cap) ----
      await fundAndApprove(seeds[0], USDC(105_000), crowdfund);
      await crowdfund.connect(seeds[0]).commit(0, USDC(100_000));
      await crowdfund.connect(seeds[0]).commit(0, USDC(5_000));
      // Verify raw commitment
      const p0 = await crowdfund.participants(seeds[0].address, 0);
      expect(p0.committed).to.equal(USDC(105_000));

      // ---- Hop-2 commits: $10K per team-wallet invitee, $20K for the stacked placement ----
      for (const h2 of hop2Invitees) {
        await fundAndApprove(h2, USDC(10_000), crowdfund);
        await crowdfund.connect(h2).commit(2, USDC(10_000));
      }
      await fundAndApprove(ltHop2[0], USDC(20_000), crowdfund);
      await crowdfund.connect(ltHop2[0]).commit(2, USDC(20_000));

      // Also the commitWithInvite invitee: already committed $2K via link

      // ---- The team wallet commits $1K at hop-1: over its $0 cap, so excluded and refunded ----
      const teamCommitter = teamWallet;
      await fundAndApprove(teamCommitter, USDC(1_000), crowdfund);
      await crowdfund.connect(teamCommitter).commit(1, USDC(1_000));

      // ---- Verify aggregate state ----
      // Raw totals
      const rawTotal = await crowdfund.totalCommitted();
      // 69 seeds × $25K + $105K (seed[0], $5K over cap) + 10 hop-2 × $10K +
      // the stacked placement $20K + 1 link invitee $2K + 1 team-wallet commit $1K
      const expectedRaw =
        USDC(25_000) * 69n +
        USDC(105_000) +
        USDC(10_000) * 10n +
        USDC(20_000) +
        USDC(2_000) +
        USDC(1_000);
      expect(rawTotal).to.equal(expectedRaw);

      // hopStats checks
      const hop0Stats = await crowdfund.getHopStats(0);
      expect(hop0Stats[0]).to.equal(USDC(25_000) * 69n + USDC(105_000)); // totalCommitted
      expect(hop0Stats[2]).to.equal(70); // uniqueCommitters

      // ---- Finalization (permissionless caller) ----
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      const finalizeTx = await crowdfund.connect(randomCaller).finalize();
      const finalizeReceipt = await finalizeTx.wait();

      // Phase check
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.false;

      // Finalized event
      const finalizedEvents = parseEvents(
        crowdfund,
        finalizeReceipt,
        "Finalized"
      );
      expect(finalizedEvents.length).to.equal(1);
      const fe = finalizedEvents[0];
      expect(fe.args.saleSize).to.equal(BASE_SALE); // $1.8M (no expansion)
      // Hop-2 fills in full ($122K) first; the known tier gets the $1.678M remainder.
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(BASE_SALE);
      expect(fe.args.allocatedArm).to.be.gt(0n);
      expect(fe.args.netProceeds).to.be.gt(0n);
      expect(fe.args.refundMode).to.be.false;

      // Lazy settlement: Allocated and AllocatedHop events are emitted at claim() time,
      // not at finalize() time. Verify none appear in the finalize receipt.
      const allParticipants = [
        ...seeds,
        ...hop2Invitees,
        ...ltHop2,
        linkInvitee,
        teamCommitter,
      ];
      expect(parseEvents(crowdfund, finalizeReceipt, "Allocated").length).to.equal(0);
      expect(parseEvents(crowdfund, finalizeReceipt, "AllocatedHop").length).to.equal(0);

      // Claim deadline
      const finalizedAt = await crowdfund.finalizedAt();
      expect(await crowdfund.claimDeadline()).to.equal(
        finalizedAt + BigInt(THREE_YEARS)
      );

      // ---- Claims: ARM + refund in single call ----
      // Claim for first 5 seeds with a delegate
      const delegate = allSigners[3]; // treasury doubles as delegate here
      for (let i = 0; i < 5; i++) {
        const [expectedArm, expectedRefund] = await crowdfund.computeAllocation(seeds[i].address);
        const armBefore = await armToken.balanceOf(seeds[i].address);
        const usdcBefore = await usdc.balanceOf(seeds[i].address);
        const claimTx = await crowdfund
          .connect(seeds[i])
          .claim(delegate.address);
        const armAfter = await armToken.balanceOf(seeds[i].address);
        const usdcAfter = await usdc.balanceOf(seeds[i].address);

        expect(armAfter - armBefore).to.equal(expectedArm);
        expect(usdcAfter - usdcBefore).to.equal(expectedRefund);

        await expect(claimTx)
          .to.emit(crowdfund, "Allocated")
          .withArgs(seeds[i].address, expectedArm, expectedRefund, delegate.address);
      }

      // The known tier is pro-rated: $1.678M over $1.825M of capped hop-0 demand
      // (69 × $25K + seed[0]'s $100K cap).
      const hop0Alloc = USDC(1_678_000);
      const hop0Demand = USDC(1_825_000);
      const [seed1Arm, seed1Refund] = await crowdfund.computeAllocation(seeds[1].address);
      const seed1Accepted = (USDC(25_000) * hop0Alloc) / hop0Demand;
      expect(seed1Arm).to.equal(seed1Accepted * 10n ** 12n);
      expect(seed1Refund).to.equal(USDC(25_000) - seed1Accepted);

      // Over-cap seed (seeds[0]): committed $105K, capped at $100K. The refund is the $5K
      // excess plus the pro-rata cut of the capped $100K.
      const [, seed0Refund] = await crowdfund.computeAllocation(seeds[0].address);
      const seed0Accepted = (USDC(100_000) * hop0Alloc) / hop0Demand;
      expect(seed0Refund).to.equal(USDC(105_000) - seed0Accepted);

      // Hop-2 is within its $300K first-priority reserve, so it is allocated in full,
      // including the stacked placement's $20K.
      const [h2Arm, h2Refund] = await crowdfund.computeAllocation(hop2Invitees[0].address);
      expect(h2Arm).to.equal(ARM(10_000));
      expect(h2Refund).to.equal(0n);
      const [stackedArm, stackedRefund] = await crowdfund.computeAllocation(ltHop2[0].address);
      expect(stackedArm).to.equal(ARM(20_000));
      expect(stackedRefund).to.equal(0n);

      // The team wallet's commit earns no ARM and is refunded in full.
      const [teamArm, teamRefund] = await crowdfund.computeAllocation(teamCommitter.address);
      expect(teamArm).to.equal(0n);
      expect(teamRefund).to.equal(USDC(1_000));

      // ---- Double-claim reverts ----
      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
      // claimRefund also reverts after claim (shared flag)
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");

      // ---- Proceeds pushed at finalization: $250K to the launch team, the rest to treasury ----
      // A hop is pro-rated, so the rounding buffer (one unit per participant node) is held back.
      await expect(finalizeTx)
        .to.emit(crowdfund, "LaunchTeamPaid")
        .withArgs(deployer.address, TEAM_PAYMENT);
      expect(await usdc.balanceOf(deployer.address)).to.equal(TEAM_PAYMENT);
      const roundingBuffer = await crowdfund.getParticipantCount();
      const treasuryUsdcBal = await usdc.balanceOf(treasury.address);
      expect(treasuryUsdcBal).to.equal(BASE_SALE - TEAM_PAYMENT - roundingBuffer);

      // ---- ARM sweep: the sale is fully allocated, so there is no unsold ARM ----
      // (A pro-rated tier means the sale filled; the partly-sold sweep is Path 1b.)
      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      expect(await crowdfund.totalAllocatedArm()).to.equal(MAX_SALE_ARM);
      await expect(
        crowdfund.connect(randomCaller).withdrawUnallocatedArm()
      ).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");
      const treasuryArmAfter = await armToken.balanceOf(treasury.address);
      expect(treasuryArmAfter).to.equal(treasuryArmBefore);

      // ================================================================
      // CONSERVATION INVARIANTS
      // ================================================================

      // ---- USDC Conservation: netProceeds + sum(refunds) == totalDeposited ----
      let sumRefunds = 0n;
      for (const p of allParticipants) {
        const [, refund] = await crowdfund.computeAllocation(p.address);
        sumRefunds += refund;
      }
      const netProceeds = await crowdfund.totalAllocatedUsdc();
      // Lazy settlement: the aggregate totalAllocatedUsdc and the sum of per-node
      // (floored) refunds diverge from rawTotal by rounding dust in *either*
      // direction — up to one unit per participant per hop. The aggregate can
      // exceed the per-node lazy sum (e.g. the $1.678M hop-0 remainder over $1.825M of
      // demand does not divide evenly), leaving dust as contract residual rather than paying
      // it out; no value is created. Bound the absolute deviation.
      const totalRefundAndProceeds = netProceeds + sumRefunds;
      const conservationDelta =
        totalRefundAndProceeds > rawTotal
          ? totalRefundAndProceeds - rawTotal
          : rawTotal - totalRefundAndProceeds;
      expect(conservationDelta).to.be.lte(
        BigInt(allParticipants.length) * 3n, // NUM_HOPS rounding buffer
        "USDC conservation violated"
      );

      // ---- ARM Conservation: transferred + swept + remaining == MAX_SALE_ARM ----
      // After some claims and the sweep, verify all ARM is accounted for.
      const totalAllocatedArm = await crowdfund.totalAllocatedArm();
      const totalArmTransferred = await crowdfund.totalArmTransferred();
      const contractArmBalance = await armToken.balanceOf(cfAddr);
      const sweptArm = treasuryArmAfter - treasuryArmBefore;
      expect(totalArmTransferred + sweptArm + contractArmBalance).to.equal(
        MAX_SALE_ARM,
        "ARM conservation violated: transferred + swept + remaining != MAX_SALE_ARM"
      );
      expect(totalAllocatedArm).to.be.gt(0n);
      expect(totalAllocatedArm).to.be.lte(MAX_SALE_ARM);

      // ---- Balance integrity: claim all remaining participants ----
      // Claim ARM + refund for all remaining participants
      for (const p of allParticipants) {
        // Skip participants who already claimed; re-throw unexpected errors
        try {
          await crowdfund.connect(p).claim(p.address);
        } catch (e: any) {
          expect(e.message).to.include("already claimed");
        }
      }

      // After all claims, contract USDC balance should be minimal (rounding dust)
      const contractUsdc = await usdc.balanceOf(cfAddr);
      // Rounding buffer is participantNodes.length * NUM_HOPS (max 1 USDC unit per participant per hop)
      const nodeCount = await crowdfund.getParticipantCount();
      const NUM_HOPS = 3n;
      expect(contractUsdc).to.be.lte(nodeCount * NUM_HOPS);

      // After sweep, remaining ARM in contract = still owed to unclaimed participants
      // Since we claimed all, it should be 0 or very small
      const contractArm = await armToken.balanceOf(cfAddr);
      // All ARM was either claimed by participants or swept to treasury, minus
      // lazy-settlement rounding dust. Per-node ARM is USDC allocation × 1e12
      // (6→18 decimals), so the USDC rounding buffer maps to nodeCount * NUM_HOPS
      // * 1e12 wei of ARM.
      expect(contractArm).to.be.lte(nodeCount * NUM_HOPS * 10n ** 12n);
    });
  });

  // ================================================================
  // Path 1b: Successful Finalization, partly sold — unsold ARM sweep
  // ================================================================

  describe("Path 1b: Successful Finalization (partly sold)", function () {
    // WHY: a successful sale below the $1.8M size leaves unsold ARM, which must be sweepable to
    // the treasury straight after finalize while every participant's allocation stays claimable.
    it("sweeps unsold ARM after a partly sold sale and keeps allocations claimable", async function () {
      const crowdfund = await deployCrowdfund();
      const cfAddr = await crowdfund.getAddress();

      // 20 seeds × $15K = $300K ≥ MIN_SALE; $1.5M of the sale is unsold.
      const seeds = allSigners.slice(5, 25);
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await crowdfund.connect(randomCaller).finalize();
      expect(await crowdfund.refundMode()).to.be.false;
      expect(await crowdfund.totalAllocatedArm()).to.equal(ARM(300_000));

      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      const sweepTx = await crowdfund.connect(randomCaller).withdrawUnallocatedArm();
      const sweepEvents = parseEvents(crowdfund, await sweepTx.wait(), "UnallocatedArmWithdrawn");
      expect(sweepEvents.length).to.equal(1);
      expect(sweepEvents[0].args.amount).to.equal(ARM(1_500_000));
      expect((await armToken.balanceOf(treasury.address)) - treasuryArmBefore).to.equal(ARM(1_500_000));

      // Allocated ARM stays in the contract for claims; a second sweep finds nothing.
      expect(await armToken.balanceOf(cfAddr)).to.equal(ARM(300_000));
      await expect(crowdfund.withdrawUnallocatedArm()).to.be.revertedWith("ArmadaCrowdfund: nothing to sweep");

      for (const s of seeds) await crowdfund.connect(s).claim(s.address);
      expect(await armToken.balanceOf(seeds[0].address)).to.equal(ARM(15_000));
      expect(await armToken.balanceOf(cfAddr)).to.equal(0n);
    });
  });

  // ================================================================
  // Path 2: No Elastic Expansion
  // ================================================================

  describe("Path 2: No Elastic Expansion", function () {
    // WHY: demand at ELASTIC_TRIGGER is where elastic expansion to MAX_SALE applies. With
    // BASE_SALE == MAX_SALE == ELASTIC_TRIGGER the sale size stays $1.8M, and
    // $1.8M of demand fills it exactly — everyone allocated in full.
    it("demand at ELASTIC_TRIGGER keeps the $1.8M sale size and fills it", async function () {
      const crowdfund = await deployCrowdfund();

      // 100 seeds × $18K = $1.8M capped demand = ELASTIC_TRIGGER
      const seeds = allSigners.slice(5, 105); // 100 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      // deployCrowdfund() already advances to windowStart

      for (const s of seeds) {
        await fundAndApprove(s, USDC(18_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(18_000));
      }

      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // No expansion beyond $1.8M
      expect(await crowdfund.saleSize()).to.equal(MAX_SALE);
      expect(await crowdfund.saleSize()).to.equal(BASE_SALE);
      expect(await crowdfund.refundMode()).to.be.false;
      expect(await crowdfund.totalAllocatedUsdc()).to.equal(ELASTIC_TRIGGER);

      // Finalized event
      const fEvents = parseEvents(crowdfund, receipt, "Finalized");
      expect(fEvents[0].args.saleSize).to.equal(MAX_SALE);
      expect(fEvents[0].args.refundMode).to.be.false;

      // Conservation: USDC
      const allParticipants = [...seeds];
      let sumRefunds = 0n;
      for (const p of allParticipants) {
        const [, refund] = await crowdfund.computeAllocation(p.address);
        sumRefunds += refund;
      }
      const netProceeds = await crowdfund.totalAllocatedUsdc();
      const totalDeposited = await crowdfund.totalCommitted();
      // Lazy settlement rounding tolerance
      const totalRefAndProc = netProceeds + sumRefunds;
      expect(totalRefAndProc).to.be.lte(totalDeposited);
      expect(totalDeposited - totalRefAndProc).to.be.lte(
        BigInt(allParticipants.length) * 3n,
        "USDC conservation violated (no expansion)"
      );

      // Conservation: ARM — verify contract holds all ARM and allocation is sensible
      const totalAllocatedArm = await crowdfund.totalAllocatedArm();
      const contractArmBalance = await armToken.balanceOf(
        await crowdfund.getAddress()
      );
      expect(contractArmBalance).to.equal(
        MAX_SALE_ARM,
        "ARM conservation violated: contract should hold all ARM before claims/sweep"
      );
      expect(totalAllocatedArm).to.be.gt(0n);
      expect(totalAllocatedArm).to.be.lte(MAX_SALE_ARM);
    });
  });

  // ================================================================
  // Path 3: RefundMode
  // ================================================================

  describe("Path 3: RefundMode", function () {
    // WHY: refund mode after allocation (net proceeds < MIN_SALE although capped demand cleared
    // it) is unreachable: allocation equals min(capped demand, saleSize).
    // The only refund-mode path is capped demand below MIN_SALE; this pins its boundary, $1
    // short of the minimum (Path 5 covers demand far below it).
    it("refundMode when capped demand is just below MIN_SALE", async function () {
      const crowdfund = await deployCrowdfund();
      const cfAddr = await crowdfund.getAddress();

      // 16 seeds × $15K = $240K, plus 1 seed at $9,999 → $249,999 < $250K MIN_SALE.
      const seeds = allSigners.slice(5, 22); // 17 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      // deployCrowdfund() already advances to windowStart

      for (const s of seeds.slice(0, 16)) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await fundAndApprove(seeds[16], USDC(9_999), crowdfund);
      await crowdfund.connect(seeds[16]).commit(0, USDC(9_999));
      expect(await crowdfund.totalCommitted()).to.equal(MIN_SALE - USDC(1));

      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // RefundMode checks
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;

      // Finalized event: capped-demand branch — saleSize not set, zero allocations, refundMode=true
      const fEvents = parseEvents(crowdfund, receipt, "Finalized");
      expect(fEvents.length).to.equal(1);
      expect(fEvents[0].args.saleSize).to.equal(0n);
      expect(fEvents[0].args.allocatedArm).to.equal(0n);
      expect(fEvents[0].args.netProceeds).to.equal(0n);
      expect(fEvents[0].args.refundMode).to.be.true;

      // No Allocated/AllocatedHop events
      expect(parseEvents(crowdfund, receipt, "Allocated").length).to.equal(0);
      expect(
        parseEvents(crowdfund, receipt, "AllocatedHop").length
      ).to.equal(0);

      // claim() reverts
      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: sale in refund mode");

      // claimRefund() returns FULL committed amount
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const usdcAfter = await usdc.balanceOf(seeds[0].address);
      expect(usdcAfter - usdcBefore).to.equal(USDC(15_000));

      // withdrawUnallocatedArm() returns all 1.8M ARM
      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryArmAfter = await armToken.balanceOf(treasury.address);
      expect(treasuryArmAfter - treasuryArmBefore).to.equal(MAX_SALE_ARM);

      // USDC conservation: all deposits refundable
      let totalRefunded = 0n;
      for (const s of seeds) {
        try {
          await crowdfund.connect(s).claimRefund();
        } catch (e: any) {
          // Only seed[0] should have already claimed; re-throw unexpected errors
          expect(e.message).to.include("already claimed");
        }
        totalRefunded += await usdc.balanceOf(s.address);
      }
      // Seeds had 0 USDC after funding; after refund each holds exactly what they committed.
      for (const s of seeds.slice(0, 16)) {
        expect(await usdc.balanceOf(s.address)).to.equal(USDC(15_000));
      }
      expect(await usdc.balanceOf(seeds[16].address)).to.equal(USDC(9_999));
      expect(totalRefunded).to.equal(MIN_SALE - USDC(1));
    });
  });

  // ================================================================
  // Path 4: Security Council Cancel
  // ================================================================

  describe("Path 4: Security Council Cancel", function () {
    it("cancel + full refund", async function () {
      const crowdfund = await deployCrowdfund();

      // Setup: 10 seeds, some commits
      const seeds = allSigners.slice(5, 15);
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      // deployCrowdfund() already advances to windowStart

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(10_000));
      }
      // Total committed: 10 × $10K = $100K

      // Cancel
      const cancelTx = await crowdfund.connect(securityCouncil).cancel();
      await expect(cancelTx).to.emit(crowdfund, "Cancelled");
      // Cancelled event has no fields — verify parse
      const cancelReceipt = await cancelTx.wait();
      const cancelEvents = parseEvents(crowdfund, cancelReceipt, "Cancelled");
      expect(cancelEvents.length).to.equal(1);

      expect(await crowdfund.phase()).to.equal(Phase.Canceled);

      // commit() reverts
      await fundAndApprove(seeds[0], USDC(1_000), crowdfund);
      await expect(
        crowdfund.connect(seeds[0]).commit(0, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active");

      // finalize() reverts
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);
      await expect(crowdfund.finalize()).to.be.revertedWith(
        "ArmadaCrowdfund: already finalized"
      );

      // claimRefund() returns full USDC
      for (const s of seeds) {
        const before = await usdc.balanceOf(s.address);
        await crowdfund.connect(s).claimRefund();
        const after = await usdc.balanceOf(s.address);
        expect(after - before).to.equal(USDC(10_000));
      }

      // withdrawUnallocatedArm() returns all ARM
      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryArmAfter = await armToken.balanceOf(treasury.address);
      expect(treasuryArmAfter - treasuryArmBefore).to.equal(MAX_SALE_ARM);
    });
  });

  // ================================================================
  // Path 5: Below-Minimum Finalization
  // ================================================================

  describe("Path 5: Below-Minimum Finalization", function () {
    // WHY: When demand is below MIN_SALE, finalize() must enter refundMode so participants
    // can claim USDC refunds and ARM is recoverable via withdrawUnallocatedArm().
    it("below-minimum finalize → refund → ARM recovery", async function () {
      const crowdfund = await deployCrowdfund();

      // Small commitments well below MIN_SALE
      const seeds = allSigners.slice(5, 8); // 3 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      // deployCrowdfund() already advances to windowStart

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      // Total: 3 × $15K = $45K << $250K MIN_SALE

      // Window expires
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      // finalize() enters refundMode (below MIN_SALE — capped < MIN_SALE branch).
      // 3 seeds × $15K = $45K committed; capped to $45K (well within slot caps).
      const finalizeTx = await crowdfund.finalize();
      await expect(finalizeTx)
        .to.emit(crowdfund, "Finalized")
        .withArgs(0, 0, 0, true, USDC(45_000), USDC(45_000));
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;

      // All participants claim full USDC refunds
      for (const s of seeds) {
        const before = await usdc.balanceOf(s.address);
        const tx = await crowdfund.connect(s).claimRefund();
        await expect(tx).to.emit(crowdfund, "RefundClaimed");
        const after = await usdc.balanceOf(s.address);
        expect(after - before).to.equal(USDC(15_000));
      }

      // ARM recovery: withdrawUnallocatedArm() sweeps all ARM to treasury
      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.withdrawUnallocatedArm();
      const treasuryArmAfter = await armToken.balanceOf(treasury.address);
      expect(treasuryArmAfter - treasuryArmBefore).to.equal(MAX_SALE_ARM);
    });
  });

});
