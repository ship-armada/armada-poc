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
const ONE_WEEK = 7 * ONE_DAY;
const THREE_WEEKS = 21 * ONE_DAY;
const THREE_YEARS = 1095 * ONE_DAY;

const BASE_SALE = USDC(1_200_000);
const MAX_SALE = USDC(1_800_000);
const MIN_SALE = USDC(1_000_000);
const ELASTIC_TRIGGER = USDC(1_500_000);
const MAX_SALE_ARM = ARM(1_800_000);

// EIP-712 types for invite signatures
const INVITE_TYPES = {
  Invite: [
    { name: "invitee", type: "address" },
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

  async function deployCrowdfund(phasedSettlement: boolean) {
    const ArmadaCrowdfund =
      await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    const crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address, // launchTeam
      securityCouncil.address,
      openTimestamp,
      phasedSettlement
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());
    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();
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
    invitee: string,
    fromHop: number,
    nonce: number,
    deadline: number,
    domain: any
  ): Promise<string> {
    return signer.signTypedData(domain, INVITE_TYPES, {
      invitee,
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
    it("complete lifecycle with all spec features", async function () {
      const crowdfund = await deployCrowdfund(false);
      const cfAddr = await crowdfund.getAddress();
      const domain = buildDomain(cfAddr);

      // ---- Verify ArmLoaded ----
      expect(await crowdfund.armLoaded()).to.be.true;

      // ---- Setup: Add 70 seeds ----
      const seeds = allSigners.slice(5, 75); // 70 seeds
      const addSeedsTx = await crowdfund.addSeeds(
        seeds.map((s) => s.address)
      );
      const addSeedsReceipt = await addSeedsTx.wait();
      const seedEvents = parseEvents(crowdfund, addSeedsReceipt, "SeedAdded");
      expect(seedEvents.length).to.equal(70);

      // Advance to window start
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

      // ---- Week 1: Launch team invites ----
      // 3 hop-1 invites from launch team
      const ltHop1 = allSigners.slice(196, 199); // 3 addresses
      for (const invitee of ltHop1) {
        const tx = await crowdfund.launchTeamInvite(invitee.address, 0);
        await expect(tx)
          .to.emit(crowdfund, "Invited")
          .withArgs(deployer.address, invitee.address, 1, 0);
      }

      // 2 hop-2 invites from launch team
      const ltHop2 = allSigners.slice(199, 200); // only 1 available signer
      // Use one signer for hop-2 launch team invite
      {
        const tx = await crowdfund.launchTeamInvite(ltHop2[0].address, 1);
        await expect(tx)
          .to.emit(crowdfund, "Invited")
          .withArgs(deployer.address, ltHop2[0].address, 2, 0);
      }

      // Verify budget tracking
      const [budgetHop1Left, budgetHop2Left] =
        await crowdfund.getLaunchTeamBudgetRemaining();
      expect(budgetHop1Left).to.equal(60 - 3); // 3 used
      expect(budgetHop2Left).to.equal(60 - 1); // 1 used

      // ---- Week 1: Peer invites ----
      // Seeds invite hop-1 participants. Use 17 seeds × 3 invites = 51 hop-1.
      const hop1Pool = allSigners.slice(105, 160); // 55 available
      const hop1Invitees: HardhatEthersSigner[] = [];
      for (let i = 0; i < 17; i++) {
        for (let j = 0; j < 3; j++) {
          const idx = i * 3 + j;
          const invitee = hop1Pool[idx];
          const tx = await crowdfund
            .connect(seeds[i])
            .invite(invitee.address, 0);
          await expect(tx)
            .to.emit(crowdfund, "Invited")
            .withArgs(seeds[i].address, invitee.address, 1, 0);
          hop1Invitees.push(invitee);
        }
      }

      // Hop-1 invites hop-2. Use first 2 hop-1 invitees, each invites 2 hop-2.
      const hop2Pool = allSigners.slice(160, 170);
      const hop2Invitees: HardhatEthersSigner[] = [];
      for (let i = 0; i < 2; i++) {
        // hop1 needs to commit first to be fully active. Fund and commit a small amount.
        await fundAndApprove(hop1Invitees[i], USDC(4_000), crowdfund);
        await crowdfund.connect(hop1Invitees[i]).commit(1, USDC(100));

        for (let j = 0; j < 2; j++) {
          const invitee = hop2Pool[i * 2 + j];
          const tx = await crowdfund
            .connect(hop1Invitees[i])
            .invite(invitee.address, 1);
          await expect(tx)
            .to.emit(crowdfund, "Invited")
            .withArgs(hop1Invitees[i].address, invitee.address, 2, 0);
          hop2Invitees.push(invitee);
        }
      }

      // ---- EIP-712 invite link: seed[17] signs invite for hop1Pool[51] ----
      const linkInviter = seeds[17];
      const linkInvitee = hop1Pool[51]; // index 51
      const linkNonce = 1;
      const linkDeadline = Number(await crowdfund.windowEnd());
      const signature = await signInvite(
        linkInviter,
        linkInvitee.address,
        0,
        linkNonce,
        linkDeadline,
        domain
      );

      // Fund the invitee and redeem via commitWithInvite
      await fundAndApprove(linkInvitee, USDC(4_000), crowdfund);
      const commitWithInviteTx = await crowdfund
        .connect(linkInvitee)
        .commitWithInvite(
          linkInviter.address,
          0,
          linkNonce,
          linkDeadline,
          signature,
          USDC(2_000)
        );
      await expect(commitWithInviteTx)
        .to.emit(crowdfund, "Invited")
        .withArgs(linkInviter.address, linkInvitee.address, 1, linkNonce);
      await expect(commitWithInviteTx)
        .to.emit(crowdfund, "Committed")
        .withArgs(linkInvitee.address, 1, USDC(2_000));

      // ---- Revoke nonce 2 from the same inviter, verify it blocks redemption ----
      const revokeTx = await crowdfund
        .connect(linkInviter)
        .revokeInviteNonce(2);
      await expect(revokeTx)
        .to.emit(crowdfund, "InviteNonceRevoked")
        .withArgs(linkInviter.address, 2);

      // Try to use revoked nonce — should revert
      const linkInvitee2 = hop1Pool[52];
      await fundAndApprove(linkInvitee2, USDC(4_000), crowdfund);
      const revokedSig = await signInvite(
        linkInviter,
        linkInvitee2.address,
        0,
        2,
        linkDeadline,
        domain
      );
      await expect(
        crowdfund
          .connect(linkInvitee2)
          .commitWithInvite(
            linkInviter.address,
            0,
            2,
            linkDeadline,
            revokedSig,
            USDC(1_000)
          )
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");

      // ---- Commitments: all 70 seeds commit $15K at hop-0 ----
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        const tx = await crowdfund.connect(s).commit(0, USDC(15_000));
        await expect(tx)
          .to.emit(crowdfund, "Committed")
          .withArgs(s.address, 0, USDC(15_000));
      }

      // ---- Over-cap deposit: seed[0] commits another $5K (total $20K > $15K cap) ----
      await fundAndApprove(seeds[0], USDC(5_000), crowdfund);
      await crowdfund.connect(seeds[0]).commit(0, USDC(5_000));
      // Verify raw commitment
      const p0 = await crowdfund.participants(seeds[0].address, 0);
      expect(p0.committed).to.equal(USDC(20_000));

      // ---- Remaining hop-1 participants commit $4K each ----
      // Skip hop1Invitees[0] and [1] — they already committed $100 each above.
      // Top them up to $4K.
      for (let i = 0; i < 2; i++) {
        await crowdfund
          .connect(hop1Invitees[i])
          .commit(1, USDC(4_000) - USDC(100));
      }
      // The rest commit fresh $4K
      for (let i = 2; i < hop1Invitees.length; i++) {
        await fundAndApprove(hop1Invitees[i], USDC(4_000), crowdfund);
        await crowdfund.connect(hop1Invitees[i]).commit(1, USDC(4_000));
      }

      // ---- Hop-2 commits $1K each ----
      for (const h2 of hop2Invitees) {
        await fundAndApprove(h2, USDC(1_000), crowdfund);
        await crowdfund.connect(h2).commit(2, USDC(1_000));
      }

      // ---- Launch team hop-1 invitees commit too ----
      for (const lt of ltHop1) {
        await fundAndApprove(lt, USDC(4_000), crowdfund);
        await crowdfund.connect(lt).commit(1, USDC(4_000));
      }

      // Launch team hop-2 invitee commits
      await fundAndApprove(ltHop2[0], USDC(1_000), crowdfund);
      await crowdfund.connect(ltHop2[0]).commit(2, USDC(1_000));

      // Also the commitWithInvite invitee: already committed $2K via link

      // ---- Verify aggregate state ----
      // Raw totals
      const rawTotal = await crowdfund.totalCommitted();
      // 70 seeds × $15K + $5K overcap + 51 hop-1 × $4K + 3 LT hop-1 × $4K +
      // 1 link invitee $2K + 4 hop-2 × $1K + 1 LT hop-2 × $1K
      const expectedRaw =
        USDC(15_000) * 70n +
        USDC(5_000) +
        USDC(4_000) * 51n +
        USDC(4_000) * 3n +
        USDC(2_000) +
        USDC(1_000) * 4n +
        USDC(1_000) * 1n;
      expect(rawTotal).to.equal(expectedRaw);

      // hopStats checks
      const hop0Stats = await crowdfund.getHopStats(0);
      expect(hop0Stats[0]).to.equal(USDC(15_000) * 70n + USDC(5_000)); // totalCommitted
      expect(hop0Stats[2]).to.equal(70); // uniqueCommitters

      // ---- Finalization (permissionless caller) ----
      await time.increase(THREE_WEEKS + 1);
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
      expect(fe.args.saleSize).to.equal(BASE_SALE); // below ELASTIC_TRIGGER
      expect(fe.args.allocatedArm).to.be.gt(0n);
      expect(fe.args.netProceeds).to.be.gt(0n);
      expect(fe.args.refundMode).to.be.false;

      // Allocated events — one per unique committing address
      const allocatedEvents = parseEvents(
        crowdfund,
        finalizeReceipt,
        "Allocated"
      );
      // Unique committers: 70 seeds + 51 hop-1 + 3 LT hop-1 + 1 link invitee + 4 hop-2 + 1 LT hop-2
      const allParticipants = [
        ...seeds,
        ...hop1Invitees,
        ...ltHop1,
        linkInvitee,
        ...hop2Invitees,
        ...ltHop2,
      ];
      const uniqueAddrs = new Set(
        allParticipants.map((s) => s.address.toLowerCase())
      );
      expect(allocatedEvents.length).to.equal(uniqueAddrs.size);

      // AllocatedHop events — every (addr, hop) with armAmount > 0
      const allocatedHopEvents = parseEvents(
        crowdfund,
        finalizeReceipt,
        "AllocatedHop"
      );
      expect(allocatedHopEvents.length).to.be.gt(0);
      for (const e of allocatedHopEvents) {
        expect(e.args.armAmount).to.be.gt(0n);
      }

      // Settlement invariant: sum(AllocatedHop) == Allocated.totalArmAmount per address
      const allocMap = new Map<string, bigint>();
      const hopSumMap = new Map<string, bigint>();
      for (const e of allocatedEvents) {
        allocMap.set(
          e.args.participant.toLowerCase(),
          e.args.totalArmAmount
        );
      }
      for (const e of allocatedHopEvents) {
        const addr = e.args.participant.toLowerCase();
        hopSumMap.set(addr, (hopSumMap.get(addr) || 0n) + e.args.armAmount);
      }
      for (const [addr, total] of allocMap) {
        expect(hopSumMap.get(addr) || 0n).to.equal(
          total,
          `AllocatedHop sum != Allocated for ${addr}`
        );
      }

      // Claim deadline
      const finalizedAt = await crowdfund.finalizedAt();
      expect(await crowdfund.claimDeadline()).to.equal(
        finalizedAt + BigInt(THREE_YEARS)
      );

      // ---- Claims: ARM ----
      // Claim for first 5 seeds with a delegate
      const delegate = allSigners[3]; // treasury doubles as delegate here
      for (let i = 0; i < 5; i++) {
        const armBefore = await armToken.balanceOf(seeds[i].address);
        const claimTx = await crowdfund
          .connect(seeds[i])
          .claim(delegate.address);
        const armAfter = await armToken.balanceOf(seeds[i].address);

        const storedAlloc = await crowdfund.addressArmAllocation(
          seeds[i].address
        );
        expect(armAfter - armBefore).to.equal(storedAlloc);

        await expect(claimTx)
          .to.emit(crowdfund, "ArmClaimed")
          .withArgs(seeds[i].address, storedAlloc, delegate.address);
      }

      // ---- Claims: USDC refund ----
      // Over-cap seed (seeds[0]) should get excess + pro-rata refund
      const refundBefore0 = await usdc.balanceOf(seeds[0].address);
      const refundTx0 = await crowdfund.connect(seeds[0]).claimRefund();
      const refundAfter0 = await usdc.balanceOf(seeds[0].address);
      const storedRefund0 = await crowdfund.addressRefundAmount(
        seeds[0].address
      );
      expect(refundAfter0 - refundBefore0).to.equal(storedRefund0);
      // Over-cap: committed $20K, capped at $15K → at least $5K excess refund
      expect(storedRefund0).to.be.gte(USDC(5_000));
      await expect(refundTx0)
        .to.emit(crowdfund, "RefundClaimed")
        .withArgs(seeds[0].address, storedRefund0);

      // Claim refund for a hop-1 participant
      const refundBefore1 = await usdc.balanceOf(hop1Invitees[5].address);
      await crowdfund.connect(hop1Invitees[5]).claimRefund();
      const refundAfter1 = await usdc.balanceOf(hop1Invitees[5].address);
      const storedRefund1 = await crowdfund.addressRefundAmount(
        hop1Invitees[5].address
      );
      expect(refundAfter1 - refundBefore1).to.equal(storedRefund1);

      // ---- Both claim + refund for same participant (both orderings) ----
      // seeds[5]: claim first, then refund
      await crowdfund.connect(seeds[5]).claim(seeds[5].address);
      await crowdfund.connect(seeds[5]).claimRefund();

      // seeds[6]: refund first, then claim
      await crowdfund.connect(seeds[6]).claimRefund();
      await crowdfund.connect(seeds[6]).claim(seeds[6].address);

      // ---- Double-claim reverts ----
      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM already claimed");
      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: already refunded");

      // ---- Treasury USDC: proceeds pushed at finalization ----
      const treasuryUsdcBal = await usdc.balanceOf(treasury.address);
      expect(treasuryUsdcBal).to.be.gt(0n);

      // ---- ARM sweep ----
      const treasuryArmBefore = await armToken.balanceOf(treasury.address);
      const sweepTx = await crowdfund
        .connect(randomCaller)
        .withdrawUnallocatedArm();
      const sweepReceipt = await sweepTx.wait();
      const sweepEvents = parseEvents(
        crowdfund,
        sweepReceipt,
        "UnallocatedArmWithdrawn"
      );
      expect(sweepEvents.length).to.equal(1);
      const treasuryArmAfter = await armToken.balanceOf(treasury.address);
      expect(treasuryArmAfter).to.be.gt(treasuryArmBefore);

      // ================================================================
      // CONSERVATION INVARIANTS
      // ================================================================

      // ---- USDC Conservation: netProceeds + sum(refunds) == totalDeposited ----
      let sumRefunds = 0n;
      for (const p of allParticipants) {
        sumRefunds += await crowdfund.addressRefundAmount(p.address);
      }
      const netProceeds = await crowdfund.totalAllocatedUsdc();
      expect(netProceeds + sumRefunds).to.equal(
        rawTotal,
        "USDC conservation violated"
      );

      // ---- ARM Conservation: claimed + swept + remaining == MAX_SALE_ARM ----
      // After some claims and the sweep, verify all ARM is accounted for.
      const totalAllocated = await crowdfund.totalAllocated();
      const totalArmClaimed = await crowdfund.totalArmClaimed();
      const contractArmBalance = await armToken.balanceOf(cfAddr);
      const sweptArm = treasuryArmAfter - treasuryArmBefore;
      expect(totalArmClaimed + sweptArm + contractArmBalance).to.equal(
        MAX_SALE_ARM,
        "ARM conservation violated: claimed + swept + remaining != MAX_SALE_ARM"
      );
      expect(totalAllocated).to.be.gt(0n);
      expect(totalAllocated).to.be.lte(MAX_SALE_ARM);

      // ---- Balance integrity: claim all remaining participants ----
      // Claim ARM + refund for all remaining participants
      for (const p of allParticipants) {
        // Skip participants who already claimed; re-throw unexpected errors
        try {
          await crowdfund.connect(p).claim(p.address);
        } catch (e: any) {
          expect(e.message).to.include("ARM already claimed");
        }
        try {
          await crowdfund.connect(p).claimRefund();
        } catch (e: any) {
          expect(e.message).to.include("already refunded");
        }
      }

      // After all claims, contract USDC balance should be minimal (rounding dust)
      const contractUsdc = await usdc.balanceOf(cfAddr);
      // Rounding buffer is participantNodes.length (small), plus any dust
      const nodeCount = await crowdfund.getParticipantCount();
      expect(contractUsdc).to.be.lte(nodeCount);

      // After sweep, remaining ARM in contract = still owed to unclaimed participants
      // Since we claimed all, it should be 0 or very small
      const contractArm = await armToken.balanceOf(cfAddr);
      // All ARM was either claimed by participants or swept to treasury
      expect(contractArm).to.equal(0n);
    });
  });

  // ================================================================
  // Path 2: Elastic Expansion
  // ================================================================

  describe("Path 2: Elastic Expansion", function () {
    it("expansion triggered at ELASTIC_TRIGGER", async function () {
      const crowdfund = await deployCrowdfund(false);

      // 100 seeds × $15K = $1.5M capped demand → triggers expansion to MAX_SALE.
      // At MAX_SALE, hop-0 ceiling ≈ $1.197M > MIN_SALE, so no hop-1 needed.
      const seeds = allSigners.slice(5, 105); // 100 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // Verify expansion
      expect(await crowdfund.saleSize()).to.equal(MAX_SALE);
      expect(await crowdfund.refundMode()).to.be.false;

      // Finalized event
      const fEvents = parseEvents(crowdfund, receipt, "Finalized");
      expect(fEvents[0].args.saleSize).to.equal(MAX_SALE);
      expect(fEvents[0].args.refundMode).to.be.false;

      // Conservation: USDC
      let sumRefunds = 0n;
      for (const s of seeds) {
        sumRefunds += await crowdfund.addressRefundAmount(s.address);
      }
      const netProceeds = await crowdfund.totalAllocatedUsdc();
      const totalDeposited = await crowdfund.totalCommitted();
      expect(netProceeds + sumRefunds).to.equal(
        totalDeposited,
        "USDC conservation violated (expansion)"
      );

      // Conservation: ARM — verify contract holds all ARM and allocation is sensible
      const totalAllocated = await crowdfund.totalAllocated();
      const contractArmBalance = await armToken.balanceOf(
        await crowdfund.getAddress()
      );
      expect(contractArmBalance).to.equal(
        MAX_SALE_ARM,
        "ARM conservation violated: contract should hold all ARM before claims/sweep"
      );
      expect(totalAllocated).to.be.gt(0n);
      expect(totalAllocated).to.be.lte(MAX_SALE_ARM);
    });
  });

  // ================================================================
  // Path 3: RefundMode
  // ================================================================

  describe("Path 3: RefundMode", function () {
    it("refundMode when net proceeds < MIN_SALE", async function () {
      const crowdfund = await deployCrowdfund(false);
      const cfAddr = await crowdfund.getAddress();

      // 80 seeds × $15K at hop-0 = $1.2M raw, but hop-0 ceiling at BASE_SALE
      // is $798K. No hop-1 demand → totalAllocUsdc = $798K < MIN_SALE → refundMode.
      const seeds = allSigners.slice(5, 85); // 80 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // RefundMode checks
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;

      // Finalized event: zeros + refundMode=true
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
          expect(e.message).to.include("already refunded");
        }
        totalRefunded += await usdc.balanceOf(s.address);
      }
      // Every seed got their $15K back (minus what they started with, which was 0
      // after fundAndApprove transferred everything to crowdfund)
      // Actually seeds had 0 USDC balance after funding. After refund each has $15K.
      for (const s of seeds) {
        expect(await usdc.balanceOf(s.address)).to.equal(USDC(15_000));
      }
    });
  });

  // ================================================================
  // Path 4: Security Council Cancel
  // ================================================================

  describe("Path 4: Security Council Cancel", function () {
    it("cancel + full refund", async function () {
      const crowdfund = await deployCrowdfund(false);

      // Setup: 10 seeds, some commits
      const seeds = allSigners.slice(5, 15);
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

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
      await time.increase(THREE_WEEKS + 1);
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
  // Path 5: Deadline Fallback
  // ================================================================

  describe("Path 5: Deadline Fallback", function () {
    it("below-minimum deadline fallback refund", async function () {
      const crowdfund = await deployCrowdfund(false);

      // Small commitments well below MIN_SALE
      const seeds = allSigners.slice(5, 8); // 3 seeds
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      // Total: 3 × $15K = $45K << $1M MIN_SALE

      // Window expires
      await time.increase(THREE_WEEKS + 1);

      // finalize() reverts
      await expect(crowdfund.finalize()).to.be.revertedWith(
        "ArmadaCrowdfund: below minimum raise"
      );

      // No Finalized event — phase is still Active
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      // claimRefund() works via deadline fallback path (path 4)
      for (const s of seeds) {
        const before = await usdc.balanceOf(s.address);
        const tx = await crowdfund.connect(s).claimRefund();
        await expect(tx).to.emit(crowdfund, "RefundClaimed");
        const after = await usdc.balanceOf(s.address);
        expect(after - before).to.equal(USDC(15_000));
      }
    });
  });

  // ================================================================
  // Path 6: Phased Settlement
  // ================================================================

  describe("Path 6: Phased Settlement", function () {
    it("phased emitSettlement batches", async function () {
      const crowdfund = await deployCrowdfund(true); // phased mode

      // Setup: 70 seeds + hop-1 demand for successful finalization
      const seeds = allSigners.slice(5, 75);
      await crowdfund.addSeeds(seeds.map((s) => s.address));
      const ws = Number(await crowdfund.windowStart());
      await time.increaseTo(ws);

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // Add hop-1 demand
      const hop1Pool = allSigners.slice(140, 195);
      for (let i = 0; i < 18; i++) {
        for (let j = 0; j < 3 && i * 3 + j < hop1Pool.length; j++) {
          const idx = i * 3 + j;
          const invitee = hop1Pool[idx];
          await crowdfund.connect(seeds[i]).invite(invitee.address, 0);
          await fundAndApprove(invitee, USDC(4_000), crowdfund);
          await crowdfund.connect(invitee).commit(1, USDC(4_000));
        }
      }

      await time.increase(THREE_WEEKS + 1);

      // Finalize — should NOT emit Allocated/AllocatedHop
      const finTx = await crowdfund.finalize();
      const finReceipt = await finTx.wait();
      expect(await crowdfund.refundMode()).to.be.false;

      expect(parseEvents(crowdfund, finReceipt, "Allocated").length).to.equal(
        0
      );
      expect(
        parseEvents(crowdfund, finReceipt, "AllocatedHop").length
      ).to.equal(0);

      // But allocations are stored
      const armAlloc = await crowdfund.addressArmAllocation(
        seeds[0].address
      );
      expect(armAlloc).to.be.gt(0n);

      // claim() works immediately (before any emitSettlement)
      expect(await crowdfund.settlementComplete()).to.be.false;
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      expect(await armToken.balanceOf(seeds[0].address)).to.be.gt(0n);

      // emitSettlement in batches — second param is COUNT, not end index
      const nodeCount = Number(await crowdfund.getParticipantCount());
      const batchSize = Math.ceil(nodeCount / 3);

      // Batch 1: startIndex=0, count=batchSize
      const tx1 = await crowdfund.emitSettlement(0, batchSize);
      const receipt1 = await tx1.wait();
      expect(
        parseEvents(crowdfund, receipt1, "Allocated").length
      ).to.be.gt(0);
      expect(await crowdfund.settlementComplete()).to.be.false;

      // Batch 2: startIndex=batchSize, count=batchSize
      const tx2 = await crowdfund.emitSettlement(batchSize, batchSize);
      const receipt2 = await tx2.wait();
      expect(
        parseEvents(crowdfund, receipt2, "Allocated").length
      ).to.be.gt(0);
      expect(await crowdfund.settlementComplete()).to.be.false;

      // Batch 3 — final: startIndex=batchSize*2, count=remaining
      const remaining = nodeCount - batchSize * 2;
      const tx3 = await crowdfund.emitSettlement(batchSize * 2, remaining);
      const receipt3 = await tx3.wait();
      expect(await crowdfund.settlementComplete()).to.be.true;

      // SettlementComplete event on final batch
      const scEvents = parseEvents(
        crowdfund,
        receipt3,
        "SettlementComplete"
      );
      expect(scEvents.length).to.equal(1);

      // emitSettlement reverts after completion
      await expect(
        crowdfund.emitSettlement(nodeCount, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: settlement already complete");
    });
  });
});
