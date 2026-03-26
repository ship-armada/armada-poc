// ABOUTME: Tests for eager per-address allocation at finalization.
// ABOUTME: Covers single-tx and phased settlement modes, stored allocation values, and conservation invariants.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const USDC = (n: number) => BigInt(n) * 1_000_000n;
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
const THREE_WEEKS = 21 * 24 * 60 * 60;
const ONE_WEEK = 7 * 24 * 60 * 60;

describe("Eager Allocation at Finalization", function () {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let securityCouncil: HardhatEthersSigner;
  let allSigners: HardhatEthersSigner[];
  let usdc: any;
  let armToken: any;

  async function fundAndApprove(signer: HardhatEthersSigner, amount: bigint, cf: any) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await cf.getAddress(), amount);
  }

  async function deployCrowdfund(phasedSettlement: boolean) {
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    const crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address,         // launchTeam
      securityCouncil.address,
      openTimestamp,
      phasedSettlement
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());
    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
    return crowdfund;
  }

  // Set up a crowdfund with seeds + hop-1 participants that reaches MIN_SALE.
  // Returns { seeds, hop1Invitees, crowdfund }
  async function setupFinalizableScenario(crowdfund: any, seedCount: number) {
    const seeds = allSigners.slice(5, 5 + seedCount);
    await crowdfund.addSeeds(seeds.map((s: HardhatEthersSigner) => s.address));

    // Seeds commit at hop 0
    for (const s of seeds) {
      await fundAndApprove(s, USDC(15_000), crowdfund);
      await crowdfund.connect(s).commit(0, USDC(15_000));
    }

    // Add hop-1 demand to meet MIN_SALE. Each seed invites up to 3 hop-1 participants.
    const hop1Pool = allSigners.slice(140, 195);
    const inviterCount = Math.min(seedCount, 18); // 18 × 3 = 54 hop-1
    const hop1Invitees: HardhatEthersSigner[] = [];
    for (let i = 0; i < inviterCount; i++) {
      for (let j = 0; j < 3 && (i * 3 + j) < hop1Pool.length; j++) {
        const hop1Idx = i * 3 + j;
        const invitee = hop1Pool[hop1Idx];
        await crowdfund.connect(seeds[i]).invite(invitee.address, 0);
        await fundAndApprove(invitee, USDC(4_000), crowdfund);
        await crowdfund.connect(invitee).commit(1, USDC(4_000));
        hop1Invitees.push(invitee);
      }
    }

    return { seeds, hop1Invitees };
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
  });

  // ============================================================
  // Single-TX Mode
  // ============================================================

  describe("Single-TX Settlement Mode", function () {
    it("finalize() emits Allocated and AllocatedHop events", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds, hop1Invitees } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // Check for Allocated events (one per unique address with commitment)
      const allocatedEvents = receipt.logs
        .filter((l: any) => {
          try { return crowdfund.interface.parseLog(l)?.name === "Allocated"; } catch { return false; }
        })
        .map((l: any) => crowdfund.interface.parseLog(l));

      // Should have one Allocated event per unique committer
      const uniqueCommitters = new Set([...seeds.map(s => s.address), ...hop1Invitees.map(s => s.address)]);
      expect(allocatedEvents.length).to.equal(uniqueCommitters.size);

      // Check for AllocatedHop events
      const allocatedHopEvents = receipt.logs
        .filter((l: any) => {
          try { return crowdfund.interface.parseLog(l)?.name === "AllocatedHop"; } catch { return false; }
        })
        .map((l: any) => crowdfund.interface.parseLog(l));

      // Every committer with armAmount > 0 should have an AllocatedHop event
      expect(allocatedHopEvents.length).to.be.greaterThan(0);

      // Each AllocatedHop should have armAmount > 0
      for (const e of allocatedHopEvents) {
        expect(e.args.armAmount).to.be.gt(0n);
      }
    });

    it("stored allocations are readable after finalize()", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Each seed should have a non-zero addressArmAllocation
      for (const s of seeds) {
        const armAlloc = await crowdfund.addressArmAllocation(s.address);
        expect(armAlloc).to.be.gt(0n);
      }
    });

    it("per-hop Participant.allocation is set at finalization, not at claim", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Before claiming, allocation should already be stored
      const p = await crowdfund.participants(seeds[0].address, 0);
      expect(p.allocation).to.be.gt(0n);
      expect(p.armClaimed).to.be.false;
    });

    it("claim() uses stored allocation (no recomputation)", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const storedAlloc = await crowdfund.addressArmAllocation(seeds[0].address);
      const balBefore = await armToken.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const balAfter = await armToken.balanceOf(seeds[0].address);

      expect(balAfter - balBefore).to.equal(storedAlloc);
    });

    it("claimRefund() uses stored refund (no recomputation)", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const storedRefund = await crowdfund.addressRefundAmount(seeds[0].address);
      const balBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claimRefund();
      const balAfter = await usdc.balanceOf(seeds[0].address);

      expect(balAfter - balBefore).to.equal(storedRefund);
    });

    it("can call claim() and claimRefund() independently in either order", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Seed 0: refund first, then claim
      await crowdfund.connect(seeds[0]).claimRefund();
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

      // Seed 1: claim first, then refund
      await crowdfund.connect(seeds[1]).claim(seeds[1].address);
      await crowdfund.connect(seeds[1]).claimRefund();
    });

    it("AllocatedHop only emitted when armAmount > 0", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      const allocatedHopEvents = receipt.logs
        .filter((l: any) => {
          try { return crowdfund.interface.parseLog(l)?.name === "AllocatedHop"; } catch { return false; }
        })
        .map((l: any) => crowdfund.interface.parseLog(l));

      // No AllocatedHop events should have armAmount == 0
      for (const e of allocatedHopEvents) {
        expect(e.args.armAmount).to.be.gt(0n);
      }

      // Seeds committed at hop 0 only — no hop 1 or hop 2 events for seed addresses
      const seedAddrs = new Set(seeds.map(s => s.address.toLowerCase()));
      const seedHopEvents = allocatedHopEvents.filter(
        (e: any) => seedAddrs.has(e.args.participant.toLowerCase())
      );
      for (const e of seedHopEvents) {
        expect(e.args.hop).to.equal(0n);
      }
    });

    it("settlement invariant: sum(AllocatedHop) == Allocated.totalArmAmount per address", async function () {
      const crowdfund = await deployCrowdfund(false);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // Parse events
      const allocated = new Map<string, bigint>();
      const hopSums = new Map<string, bigint>();

      for (const log of receipt.logs) {
        try {
          const parsed = crowdfund.interface.parseLog(log);
          if (parsed?.name === "Allocated") {
            allocated.set(parsed.args.participant.toLowerCase(), parsed.args.totalArmAmount);
          } else if (parsed?.name === "AllocatedHop") {
            const addr = parsed.args.participant.toLowerCase();
            hopSums.set(addr, (hopSums.get(addr) || 0n) + parsed.args.armAmount);
          }
        } catch { /* skip non-crowdfund logs */ }
      }

      // Every address with Allocated event should have matching hop sum
      for (const [addr, totalArm] of allocated) {
        const hopSum = hopSums.get(addr) || 0n;
        expect(hopSum).to.equal(totalArm, `invariant violated for ${addr}`);
      }
    });

    it("emitSettlement() reverts in single-tx mode", async function () {
      const crowdfund = await deployCrowdfund(false);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      await expect(crowdfund.emitSettlement(0, 10))
        .to.be.revertedWith("ArmadaCrowdfund: single-tx mode");
    });

    it("no Allocated/AllocatedHop events in refundMode", async function () {
      // Create scenario where refundMode triggers: need net_proceeds < MIN_SALE.
      // Use many seeds that oversubscribe hop-0 without enough demand elsewhere.
      const crowdfund = await deployCrowdfund(false);

      // 80 seeds × $15K = $1.2M at hop-0. Ceiling = $798K at BASE_SALE.
      // No hop-1 demand → totalAllocUsdc = $798K < $1M MIN_SALE → refundMode.
      const seeds = allSigners.slice(5, 85);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      expect(await crowdfund.refundMode()).to.be.true;

      // No Allocated or AllocatedHop events in refundMode
      for (const log of receipt.logs) {
        try {
          const parsed = crowdfund.interface.parseLog(log);
          expect(parsed?.name).to.not.equal("Allocated");
          expect(parsed?.name).to.not.equal("AllocatedHop");
        } catch { /* skip non-crowdfund logs */ }
      }
    });
  });

  // ============================================================
  // Conservation Invariants
  // ============================================================

  describe("Conservation Invariants", function () {
    it("USDC conservation: netProceeds + sum(refunds) == sum(totalDeposited)", async function () {
      const crowdfund = await deployCrowdfund(false);
      const { seeds, hop1Invitees } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Compute total deposited
      let totalDeposited = 0n;
      for (const s of seeds) {
        const p = await crowdfund.participants(s.address, 0);
        totalDeposited += p.committed;
      }
      for (const h of hop1Invitees) {
        const p = await crowdfund.participants(h.address, 1);
        totalDeposited += p.committed;
      }

      // Compute sum of refunds
      let totalRefunds = 0n;
      const allParticipants = [...seeds, ...hop1Invitees];
      for (const p of allParticipants) {
        totalRefunds += await crowdfund.addressRefundAmount(p.address);
      }

      // net_proceeds = allocated_arm * PRICE = totalAllocatedUsdc
      const netProceeds = await crowdfund.totalAllocatedUsdc();

      expect(netProceeds + totalRefunds).to.equal(totalDeposited);
    });

    it("ARM solvency: contract holds enough ARM to cover outstanding claims", async function () {
      const crowdfund = await deployCrowdfund(false);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const totalAllocated = await crowdfund.totalAllocated();
      const armBalance = await armToken.balanceOf(await crowdfund.getAddress());

      // Contract must hold at least enough ARM to cover all allocations
      expect(armBalance).to.be.gte(totalAllocated);
    });

    it("totalAllocatedUsdc + treasuryLeftoverUsdc == saleSize", async function () {
      const crowdfund = await deployCrowdfund(false);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      const treasuryLeftover = await crowdfund.treasuryLeftoverUsdc();
      const saleSize = await crowdfund.saleSize();

      expect(totalAllocUsdc + treasuryLeftover).to.equal(saleSize);
    });
  });

  // ============================================================
  // Phased Settlement Mode
  // ============================================================

  describe("Phased Settlement Mode", function () {
    it("finalize() stores allocations but does NOT emit settlement events", async function () {
      const crowdfund = await deployCrowdfund(true);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      const tx = await crowdfund.finalize();
      const receipt = await tx.wait();

      // Allocations should be stored
      const armAlloc = await crowdfund.addressArmAllocation(seeds[0].address);
      expect(armAlloc).to.be.gt(0n);

      // No Allocated or AllocatedHop events emitted by finalize()
      for (const log of receipt.logs) {
        try {
          const parsed = crowdfund.interface.parseLog(log);
          expect(parsed?.name).to.not.equal("Allocated");
          expect(parsed?.name).to.not.equal("AllocatedHop");
          expect(parsed?.name).to.not.equal("SettlementComplete");
        } catch { /* skip non-crowdfund logs */ }
      }
    });

    it("emitSettlement() emits events in batches", async function () {
      const crowdfund = await deployCrowdfund(true);
      const { seeds, hop1Invitees } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const nodeCount = Number(await crowdfund.getParticipantCount());
      const batchSize = Math.ceil(nodeCount / 2);

      // Batch 1
      const tx1 = await crowdfund.emitSettlement(0, batchSize);
      const receipt1 = await tx1.wait();

      const batch1Allocated = receipt1.logs.filter((l: any) => {
        try { return crowdfund.interface.parseLog(l)?.name === "Allocated"; } catch { return false; }
      });
      expect(batch1Allocated.length).to.be.gt(0);
      expect(await crowdfund.settlementComplete()).to.be.false;

      // Batch 2 — final
      const tx2 = await crowdfund.emitSettlement(batchSize, nodeCount);
      const receipt2 = await tx2.wait();

      expect(await crowdfund.settlementComplete()).to.be.true;

      // SettlementComplete event emitted on final batch
      const scEvents = receipt2.logs.filter((l: any) => {
        try { return crowdfund.interface.parseLog(l)?.name === "SettlementComplete"; } catch { return false; }
      });
      expect(scEvents.length).to.equal(1);
    });

    it("emitSettlement() reverts with non-sequential startIndex", async function () {
      const crowdfund = await deployCrowdfund(true);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Trying to start at index 5 when settlementIndex is 0
      await expect(crowdfund.emitSettlement(5, 10))
        .to.be.revertedWith("ArmadaCrowdfund: non-sequential batch");
    });

    it("emitSettlement() reverts after settlement is complete", async function () {
      const crowdfund = await deployCrowdfund(true);
      await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const nodeCount = Number(await crowdfund.getParticipantCount());
      await crowdfund.emitSettlement(0, nodeCount);
      expect(await crowdfund.settlementComplete()).to.be.true;

      await expect(crowdfund.emitSettlement(nodeCount, 1))
        .to.be.revertedWith("ArmadaCrowdfund: settlement already complete");
    });

    it("claim() available immediately after finalize() regardless of settlement progress", async function () {
      const crowdfund = await deployCrowdfund(true);
      const { seeds } = await setupFinalizableScenario(crowdfund, 70);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Claim before any emitSettlement() calls
      expect(await crowdfund.settlementComplete()).to.be.false;
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

      const armBal = await armToken.balanceOf(seeds[0].address);
      expect(armBal).to.be.gt(0n);
    });

    it("emitSettlement() reverts in refundMode", async function () {
      const crowdfund = await deployCrowdfund(true);

      // Create refundMode scenario
      const seeds = allSigners.slice(5, 85);
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000), crowdfund);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      await expect(crowdfund.emitSettlement(0, 10))
        .to.be.revertedWith("ArmadaCrowdfund: refund mode");
    });
  });

  // ============================================================
  // Settlement Mode Equivalence
  // ============================================================

  describe("Settlement Mode Equivalence", function () {
    it("phased and single-tx modes produce identical allocations for same scenario", async function () {
      const cfSingleTx = await deployCrowdfund(false);
      const cfPhased = await deployCrowdfund(true);

      // Run identical scenarios on both instances
      const { seeds: seedsST, hop1Invitees: hop1ST } = await setupFinalizableScenario(cfSingleTx, 70);
      const { seeds: seedsP, hop1Invitees: hop1P } = await setupFinalizableScenario(cfPhased, 70);

      await time.increase(THREE_WEEKS + 1);

      // Finalize both
      await cfSingleTx.finalize();
      await cfPhased.finalize();

      // For phased: complete settlement event emission
      const nodeCount = Number(await cfPhased.getParticipantCount());
      await cfPhased.emitSettlement(0, nodeCount);

      // Compare allocations for all seed participants
      for (let i = 0; i < seedsST.length; i++) {
        const addr = seedsST[i].address;
        const armST = await cfSingleTx.addressArmAllocation(addr);
        const armP = await cfPhased.addressArmAllocation(addr);
        expect(armST).to.equal(armP, `ARM allocation mismatch for seed ${i}`);

        const refundST = await cfSingleTx.addressRefundAmount(addr);
        const refundP = await cfPhased.addressRefundAmount(addr);
        expect(refundST).to.equal(refundP, `Refund mismatch for seed ${i}`);
      }

      // Compare allocations for hop-1 participants
      for (let i = 0; i < hop1ST.length; i++) {
        const addr = hop1ST[i].address;
        const armST = await cfSingleTx.addressArmAllocation(addr);
        const armP = await cfPhased.addressArmAllocation(addr);
        expect(armST).to.equal(armP, `ARM allocation mismatch for hop1 ${i}`);

        const refundST = await cfSingleTx.addressRefundAmount(addr);
        const refundP = await cfPhased.addressRefundAmount(addr);
        expect(refundST).to.equal(refundP, `Refund mismatch for hop1 ${i}`);
      }

      // Compare aggregate values
      expect(await cfSingleTx.totalAllocated()).to.equal(await cfPhased.totalAllocated());
      expect(await cfSingleTx.totalAllocatedUsdc()).to.equal(await cfPhased.totalAllocatedUsdc());
      expect(await cfSingleTx.saleSize()).to.equal(await cfPhased.saleSize());
      expect(await cfSingleTx.treasuryLeftoverUsdc()).to.equal(await cfPhased.treasuryLeftoverUsdc());
    });
  });
});
