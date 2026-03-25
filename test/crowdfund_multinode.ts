// ABOUTME: Tests the (address, hop) node model with invite-scaling.
// ABOUTME: Covers self-invitation, recursive self-fill, invite stacking, and aggregate claim/refund.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const ONE_DAY = 86400;
const THREE_WEEKS = 21 * ONE_DAY;

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund Multi-Node", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let seed1: SignerWithAddress;
  let seed2: SignerWithAddress;
  let seed3: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  async function setupWithSeeds(seeds: SignerWithAddress[]) {
    await crowdfund.addSeeds(seeds.map(s => s.address));
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [deployer, seed1, seed2, seed3, alice, bob, treasury] = signers;

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
      deployer.address,
      deployer.address,       // securityCouncil
      openTimestamp,           // openTimestamp
      false                    // single-tx settlement
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());

    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    for (const signer of [seed1, seed2, seed3, alice, bob]) {
      await fundAndApprove(signer, USDC(50_000));
    }
  });

  // ============================================================
  // Self-Invitation
  // ============================================================

  describe("Self-Invitation", function () {
    it("should allow a seed to invite itself to hop-1", async function () {
      await setupWithSeeds([seed1]);

      // seed1 (hop-0) invites itself to hop-1
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      expect(await crowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
      expect(await crowdfund.isWhitelisted(seed1.address, 1)).to.be.true;
    });

    it("should allow full recursive self-invitation: hop-0 → hop-1 ×3 → hop-2 ×6", async function () {
      await setupWithSeeds([seed1]);

      // seed1 uses all 3 hop-1 invites on itself
      await crowdfund.connect(seed1).invite(seed1.address, 0);
      await crowdfund.connect(seed1).invite(seed1.address, 0);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // Check: seed1 is at hop-1 with 3 invites received
      expect(await crowdfund.getInvitesReceived(seed1.address, 1)).to.equal(3);

      // seed1 at hop-1 has 3*2 = 6 outgoing hop-2 invite slots
      expect(await crowdfund.getInvitesRemaining(seed1.address, 1)).to.equal(6);

      // seed1 uses all 6 hop-2 invites on itself
      for (let i = 0; i < 6; i++) {
        await crowdfund.connect(seed1).invite(seed1.address, 1);
      }

      expect(await crowdfund.getInvitesReceived(seed1.address, 2)).to.equal(6);
      // hop-2 has 0 outgoing invites regardless
      expect(await crowdfund.getInvitesRemaining(seed1.address, 2)).to.equal(0);
    });

    it("should track self-loop edges in invite graph", async function () {
      await setupWithSeeds([seed1]);

      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // First inviter is recorded
      const inviter = await crowdfund.getInviteEdge(seed1.address, 1);
      expect(inviter).to.equal(seed1.address);
    });
  });

  // ============================================================
  // Invite-Scaling Caps
  // ============================================================

  describe("Invite-Scaling Caps", function () {
    it("should scale effective cap with invitesReceived", async function () {
      await setupWithSeeds([seed1, seed2, seed3]);

      // seed1, seed2, seed3 all invite alice to hop-1
      await crowdfund.connect(seed1).invite(alice.address, 0);
      await crowdfund.connect(seed2).invite(alice.address, 0);
      await crowdfund.connect(seed3).invite(alice.address, 0);

      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(3);
      // Effective cap = 3 * $4000 = $12000
      expect(await crowdfund.getEffectiveCap(alice.address, 1)).to.equal(USDC(12_000));
    });

    it("should allow commitment up to scaled cap", async function () {
      await setupWithSeeds([seed1, seed2]);

      // Two seeds invite alice to hop-1 → cap = 2 * $4000 = $8000
      await crowdfund.connect(seed1).invite(alice.address, 0);
      await crowdfund.connect(seed2).invite(alice.address, 0);

      // Alice can commit up to $8000
      await crowdfund.connect(alice).commit(1, USDC(8_000));
      expect(await crowdfund.getCommitment(alice.address, 1)).to.equal(USDC(8_000));
    });

    it("should accept commitment exceeding scaled cap (excess refunded at settlement)", async function () {
      await setupWithSeeds([seed1]);

      // One invite → cap = 1 * $4000 = $4000
      await crowdfund.connect(seed1).invite(alice.address, 0);

      await crowdfund.connect(alice).commit(1, USDC(4_001));

      // Over-cap deposits are accepted; raw commitment includes the full amount
      const committed = await crowdfund.getCommitment(alice.address, 1);
      expect(committed).to.equal(USDC(4_001));

      const [tc1] = await crowdfund.getHopStats(1);
      expect(tc1).to.equal(USDC(4_001));
    });

    it("should scale outgoing invite budget with invitesReceived", async function () {
      await setupWithSeeds([seed1, seed2, seed3]);

      // 3 invites to alice at hop-1 → 3*2 = 6 outgoing hop-2 slots
      await crowdfund.connect(seed1).invite(alice.address, 0);
      await crowdfund.connect(seed2).invite(alice.address, 0);
      await crowdfund.connect(seed3).invite(alice.address, 0);

      expect(await crowdfund.getInvitesRemaining(alice.address, 1)).to.equal(6);

      // Alice can invite 6 people to hop-2
      const signers = await ethers.getSigners();
      for (let i = 0; i < 6; i++) {
        await crowdfund.connect(alice).invite(signers[10 + i].address, 1);
      }

      // 7th invite should fail
      await expect(
        crowdfund.connect(alice).invite(signers[16].address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });
  });

  // ============================================================
  // Re-Invite (Subsequent Invites to Same Node)
  // ============================================================

  describe("Re-Invite", function () {
    it("should not revert on second invite to same (address, hop)", async function () {
      await setupWithSeeds([seed1, seed2]);

      await crowdfund.connect(seed1).invite(alice.address, 0);
      // Second invite from different seed — should NOT revert
      await crowdfund.connect(seed2).invite(alice.address, 0);

      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(2);
    });

    it("should emit Invited on re-invite", async function () {
      await setupWithSeeds([seed1, seed2]);

      await crowdfund.connect(seed1).invite(alice.address, 0);

      // Second invite should also emit Invited (spec: every invite edge emits Invited)
      await expect(crowdfund.connect(seed2).invite(alice.address, 0))
        .to.emit(crowdfund, "Invited")
        .withArgs(seed2.address, alice.address, 1, 0);
    });

    it("should not duplicate participantNodes entry on re-invite", async function () {
      await setupWithSeeds([seed1, seed2]);
      const countBefore = await crowdfund.getParticipantCount();

      await crowdfund.connect(seed1).invite(alice.address, 0);
      const countAfterFirst = await crowdfund.getParticipantCount();

      await crowdfund.connect(seed2).invite(alice.address, 0);
      const countAfterSecond = await crowdfund.getParticipantCount();

      // Only one new node added (not two)
      expect(countAfterFirst - countBefore).to.equal(1);
      expect(countAfterSecond - countAfterFirst).to.equal(0);
    });

    it("should preserve original invitedBy on re-invite", async function () {
      await setupWithSeeds([seed1, seed2]);

      await crowdfund.connect(seed1).invite(alice.address, 0);
      await crowdfund.connect(seed2).invite(alice.address, 0);

      // First inviter is preserved
      expect(await crowdfund.getInviteEdge(alice.address, 1)).to.equal(seed1.address);
    });
  });

  // ============================================================
  // Per-Hop Invite-Received Caps
  // ============================================================

  describe("Per-Hop Invite-Received Caps", function () {
    it("hop-1 maxInvitesReceived is 10", async function () {
      // Need 10 seeds to send 10 invites to the same hop-1 address
      const signers = await ethers.getSigners();
      const seeds = signers.slice(10, 20);
      await setupWithSeeds(seeds);

      // All 10 seeds invite alice to hop-1
      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(seeds[i]).invite(alice.address, 0);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(10);

      // Need an 11th seed to attempt the overflow
      const extraSeed = signers[20];
      await crowdfund.addSeeds([extraSeed.address]);
      await expect(
        crowdfund.connect(extraSeed).invite(alice.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("hop-2 maxInvitesReceived is 20", async function () {
      // Need 20 hop-1 addresses to send 20 invites to the same hop-2 address
      const signers = await ethers.getSigners();
      const seeds = signers.slice(10, 17); // 7 seeds, each with 3 outgoing invites = 21 hop-1 addresses
      await setupWithSeeds(seeds);

      // Create 21 hop-1 addresses
      const hop1Addrs: any[] = [];
      for (let i = 0; i < seeds.length; i++) {
        for (let j = 0; j < 3; j++) {
          const idx = 20 + i * 3 + j;
          if (idx < signers.length) {
            await crowdfund.connect(seeds[i]).invite(signers[idx].address, 0);
            hop1Addrs.push(signers[idx]);
          }
        }
      }

      // First 20 hop-1 addresses invite alice to hop-2
      for (let i = 0; i < 20; i++) {
        await crowdfund.connect(hop1Addrs[i]).invite(alice.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(20);

      // 21st should revert
      await expect(
        crowdfund.connect(hop1Addrs[20]).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("different hops enforce different caps", async function () {
      // Hop-1 cap is 10, hop-2 cap is 20 — verify they're independent
      const signers = await ethers.getSigners();
      const seeds = signers.slice(10, 21); // 11 seeds
      await setupWithSeeds(seeds);

      // 10 invites to alice at hop-1 succeed, 11th fails
      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(seeds[i]).invite(alice.address, 0);
      }
      await expect(
        crowdfund.connect(seeds[10]).invite(alice.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");

      // Meanwhile alice can still receive invites at hop-2 (different node)
      // Use two of the seeds' hop-1 invitees to invite alice at hop-2
      const bob = signers[25];
      const carol = signers[26];
      await crowdfund.connect(seeds[0]).invite(bob.address, 0);
      await crowdfund.connect(seeds[1]).invite(carol.address, 0);
      await crowdfund.connect(bob).invite(alice.address, 1);
      await crowdfund.connect(carol).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(2);
    });
  });

  // ============================================================
  // Full Recursive Self-Fill ($33k)
  // ============================================================

  describe("Full Recursive Self-Fill", function () {
    it("should allow seed to commit $33k total across all hops via recursive self-invitation", async function () {
      await setupWithSeeds([seed1]);

      // Self-invite to hop-1 ×3
      await crowdfund.connect(seed1).invite(seed1.address, 0);
      await crowdfund.connect(seed1).invite(seed1.address, 0);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // Self-invite to hop-2 ×6
      for (let i = 0; i < 6; i++) {
        await crowdfund.connect(seed1).invite(seed1.address, 1);
      }

      // Verify caps
      expect(await crowdfund.getEffectiveCap(seed1.address, 0)).to.equal(USDC(15_000)); // 1 * $15k
      expect(await crowdfund.getEffectiveCap(seed1.address, 1)).to.equal(USDC(12_000)); // 3 * $4k
      expect(await crowdfund.getEffectiveCap(seed1.address, 2)).to.equal(USDC(6_000));  // 6 * $1k

      // Commit at all three hops
      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed1).commit(1, USDC(12_000));
      await crowdfund.connect(seed1).commit(2, USDC(6_000));

      // Verify commitments
      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(15_000));
      expect(await crowdfund.getCommitment(seed1.address, 1)).to.equal(USDC(12_000));
      expect(await crowdfund.getCommitment(seed1.address, 2)).to.equal(USDC(6_000));

      // Total committed
      expect(await crowdfund.totalCommitted()).to.equal(USDC(33_000));
    });
  });

  // ============================================================
  // Independent Nodes
  // ============================================================

  describe("Independent Nodes", function () {
    it("should track uniqueCommitters per-node, not per-address", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      await crowdfund.connect(seed1).commit(0, USDC(100));
      await crowdfund.connect(seed1).commit(1, USDC(100));

      // Each hop should show 1 unique committer
      const [, , committers0] = await crowdfund.getHopStats(0);
      const [, , committers1] = await crowdfund.getHopStats(1);
      expect(committers0).to.equal(1);
      expect(committers1).to.equal(1);
    });

    it("should enforce caps independently per node", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // Max out hop-0 cap
      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      // Can still commit at hop-1 (independent cap)
      await crowdfund.connect(seed1).commit(1, USDC(4_000));

      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(15_000));
      expect(await crowdfund.getCommitment(seed1.address, 1)).to.equal(USDC(4_000));
    });

    it("should enforce invite budgets independently per node", async function () {
      await setupWithSeeds([seed1]);
      // seed1 at hop-0 has 3 invites. Use 2 on alice and bob.
      await crowdfund.connect(seed1).invite(alice.address, 0);
      await crowdfund.connect(seed1).invite(bob.address, 0);

      // seed1 also invited itself to hop-1 (using 3rd invite)
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // seed1 at hop-0 is now out of invites
      expect(await crowdfund.getInvitesRemaining(seed1.address, 0)).to.equal(0);

      // But seed1 at hop-1 has its own budget (1 * 2 = 2 invites)
      expect(await crowdfund.getInvitesRemaining(seed1.address, 1)).to.equal(2);
    });
  });

  // ============================================================
  // Aggregate Claim
  // ============================================================

  describe("Aggregate Claim", function () {
    // Helper: create a funded crowdfund with enough demand to finalize.
    // Adds hop-1 demand to avoid refundMode (hop-0 ceiling $798K < MIN_SALE at BASE_SALE).
    async function setupAndFinalize() {
      const signers = await ethers.getSigners();
      // Use many seeds to get above MIN_SALE
      const seeds = signers.slice(1, 80);
      await crowdfund.addSeeds(seeds.map((s: SignerWithAddress) => s.address));

      // seed1 self-invites to hop-1
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      // Additional hop-1 participants to push totalAllocUsdc above MIN_SALE
      const hop1Pool = signers.slice(140, 190);
      for (let i = 0; i < 50; i++) {
        await crowdfund.connect(seeds[i + 1]).invite(hop1Pool[i].address, 0);
      }

      // Each seed commits $15k → 79 seeds * $15k = $1.185M
      // seed1 needs extra for hop-1 commit
      for (const s of seeds) {
        const extra = s.address === seed1.address ? USDC(19_000) : USDC(15_000);
        await fundAndApprove(s, extra);
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // seed1 also commits $4k at hop-1
      await crowdfund.connect(seed1).commit(1, USDC(4_000));

      // hop-1 participants commit $4K each → 50 × $4K = $200K
      // totalAllocUsdc = $798K (hop-0) + $204K (hop-1) = $1,002K > MIN_SALE
      for (const h of hop1Pool) {
        await fundAndApprove(h, USDC(4_000));
        await crowdfund.connect(h).commit(1, USDC(4_000));
      }

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
    }

    it("should aggregate ARM from multiple hops in a single claim", async function () {
      await setupAndFinalize();

      const [allocBefore] = await crowdfund.getAllocation(seed1.address);
      expect(allocBefore).to.be.gt(0);

      const armBefore = await armToken.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claim(ethers.ZeroAddress);
      const armAfter = await armToken.balanceOf(seed1.address);

      expect(armAfter - armBefore).to.equal(allocBefore);
    });

    it("should revert double-claim", async function () {
      await setupAndFinalize();

      await crowdfund.connect(seed1).claim(ethers.ZeroAddress);

      await expect(
        crowdfund.connect(seed1).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM already claimed");
    });
  });

  // ============================================================
  // Aggregate Refund
  // ============================================================

  describe("Aggregate Refund", function () {
    it("should aggregate refund across hops via deadline fallback", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed1).commit(1, USDC(4_000));

      // Not enough total → finalize reverts, use claimRefund deadline fallback
      await time.increase(THREE_WEEKS + 1);

      const usdcBefore = await usdc.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claimRefund();
      const usdcAfter = await usdc.balanceOf(seed1.address);

      // Full $19k refund (both hops)
      expect(usdcAfter - usdcBefore).to.equal(USDC(19_000));
    });

    it("should aggregate refund across hops when canceled", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(seed1.address, 0);

      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed1).commit(1, USDC(4_000));

      // securityCouncil (deployer in this test's beforeEach) cancels the crowdfund
      await crowdfund.connect(deployer).cancel();
      expect(await crowdfund.phase()).to.equal(2); // Phase.Canceled

      const usdcBefore = await usdc.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claimRefund();
      const usdcAfter = await usdc.balanceOf(seed1.address);

      // Full $19k refund (both hops)
      expect(usdcAfter - usdcBefore).to.equal(USDC(19_000));
    });
  });

  // ============================================================
  // View Functions
  // ============================================================

  describe("View Functions", function () {
    it("getEffectiveCap returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getEffectiveCap(alice.address, 0)).to.equal(0);
    });

    it("getInvitesReceived returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getInvitesReceived(alice.address, 0)).to.equal(0);
    });

    it("getInvitesRemaining returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getInvitesRemaining(alice.address, 0)).to.equal(0);
    });

    it("getParticipantCount reflects unique (address, hop) nodes", async function () {
      await setupWithSeeds([seed1]);
      expect(await crowdfund.getParticipantCount()).to.equal(1);

      await crowdfund.connect(seed1).invite(seed1.address, 0);
      // seed1 at hop-0 + seed1 at hop-1 = 2 nodes
      expect(await crowdfund.getParticipantCount()).to.equal(2);

      // Re-invite doesn't add a new node
      // (need a second seed for this)
    });

    it("getInviteEdge visible during active sale (no phase restriction)", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(alice.address, 0);

      // Should be readable during Active phase
      const inviter = await crowdfund.getInviteEdge(alice.address, 1);
      expect(inviter).to.equal(seed1.address);
    });
  });
});
