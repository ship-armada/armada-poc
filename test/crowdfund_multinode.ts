// ABOUTME: Tests the (address, hop) node model: multi-hop participation, invite limits without stacking,
// ABOUTME: self-invitation by team wallets, per-node caps and budgets, and aggregate claim/refund.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

// Relaunch layout: hop-0 known contributors ($150K, cannot invite); hop-1 team inviter wallets
// ($0 cap, 100 invites each); hop-2 invited contributors ($10K, cannot invite). Every hop accepts
// one invite per address (no stacking).
describe("Crowdfund Multi-Node", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress; // launch team and security council in this suite
  let seed1: SignerWithAddress;
  let seed2: SignerWithAddress;
  let seed3: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let treasury: SignerWithAddress;
  let team1: SignerWithAddress;
  let team2: SignerWithAddress;

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  async function setupWithSeeds(seeds: SignerWithAddress[]) {
    await crowdfund.addSeeds(seeds.map(s => s.address));
  }

  // The launch team places hop-1 team inviter wallets (the only tier that can invite).
  async function placeTeamWallets(wallets: SignerWithAddress[]) {
    for (const w of wallets) await crowdfund.launchTeamInvite(w.address, 0);
  }

  async function warpPastWindow() {
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [deployer, seed1, seed2, seed3, alice, bob, treasury, team1, team2] = signers;

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
      openTimestamp            // openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    await armToken.transfer(cfAddr, ARM(1_500_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    for (const signer of [seed1, seed2, seed3, alice, bob, team1, team2]) {
      await fundAndApprove(signer, USDC(200_000));
    }
  });

  // ============================================================
  // Self-Invitation
  // ============================================================

  describe("Self-Invitation", function () {
    // WHY: known contributors cannot invite (HOP0_MAX_INVITES = 0), so a seed cannot add itself
    //      to the next hop.
    it("should not allow a seed to invite itself to hop-1", async function () {
      await setupWithSeeds([seed1]);

      await expect(
        crowdfund.connect(seed1).invite(seed1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");

      expect(await crowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
      expect(await crowdfund.isWhitelisted(seed1.address, 1)).to.be.false;
    });

    // WHY: a team wallet can take one hop-2 slot for itself; with no stacking a second
    //      self-invite reverts, and hop-2 has no outgoing invites to recurse further.
    it("should allow a team wallet one self-invitation to hop-2, and no more", async function () {
      await placeTeamWallets([team1]);

      await crowdfund.connect(team1).invite(team1.address, 1);
      expect(await crowdfund.getInvitesReceived(team1.address, 2)).to.equal(1);
      // The self-invite used one of the team wallet's 100 hop-1 invites
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(99);

      await expect(
        crowdfund.connect(team1).invite(team1.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      expect(await crowdfund.getInvitesReceived(team1.address, 2)).to.equal(1);
      // hop-2 has 0 outgoing invites regardless
      expect(await crowdfund.getInvitesRemaining(team1.address, 2)).to.equal(0);
    });

    it("should track self-loop edges in invite graph", async function () {
      await placeTeamWallets([team1]);

      await crowdfund.connect(team1).invite(team1.address, 1);

      // First inviter is recorded
      const inviter = await crowdfund.getInviteEdge(team1.address, 2);
      expect(inviter).to.equal(team1.address);
    });
  });

  // ============================================================
  // Caps Do Not Scale (no stacking)
  // ============================================================

  describe("Invite-Scaling Caps", function () {
    // WHY: every hop's maxInvitesReceived is 1, so a second invite (from another team wallet)
    //      cannot scale a hop-2 contributor's cap past $10K.
    it("should not scale effective cap: a second invite reverts and the cap stays $10K", async function () {
      await placeTeamWallets([team1, team2]);

      await crowdfund.connect(team1).invite(alice.address, 1);
      await expect(
        crowdfund.connect(team2).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");

      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(10_000));
    });

    it("should allow commitment up to the cap", async function () {
      await placeTeamWallets([team1]);
      await crowdfund.connect(team1).invite(alice.address, 1);

      // Alice can commit up to $10K
      await crowdfund.connect(alice).commit(2, USDC(10_000));
      expect(await crowdfund.getCommitment(alice.address, 2)).to.equal(USDC(10_000));
    });

    it("should accept commitment exceeding the cap (excess refunded at settlement)", async function () {
      await placeTeamWallets([team1]);

      // One invite → cap = $10K
      await crowdfund.connect(team1).invite(alice.address, 1);

      await crowdfund.connect(alice).commit(2, USDC(10_001));

      // Over-cap deposits are accepted; raw commitment includes the full amount
      const committed = await crowdfund.getCommitment(alice.address, 2);
      expect(committed).to.equal(USDC(10_001));

      const [tc2] = await crowdfund.getHopStats(2);
      expect(tc2).to.equal(USDC(10_001));
    });

    // WHY: a team wallet's outgoing budget is fixed at 1 × 100 invites; the 101st direct
    //      invite must revert.
    it("should cap a team wallet's outgoing invite budget at 100", async function () {
      await placeTeamWallets([team1]);
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(100);

      const signers = await ethers.getSigners();
      for (let i = 0; i < 100; i++) {
        await crowdfund.connect(team1).invite(signers[50 + i].address, 1);
      }

      // 101st invite should fail
      await expect(
        crowdfund.connect(team1).invite(signers[150].address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });
  });

  // ============================================================
  // No Invite Stacking
  // ============================================================

  describe("Invite Stacking Economics", function () {
    it("should not increment invitesReceived on a re-invite from a different inviter", async function () {
      await placeTeamWallets([team1, team2]);

      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);

      await expect(crowdfund.connect(team2).invite(alice.address, 1)).to.be.reverted;
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);
    });

    // WHY: a repeat launch-team placement of a team wallet at hop-1 must revert, so its $0 cap
    //      cannot be scaled into an allocation.
    it("should not scale a team wallet's $0 cap by re-placement", async function () {
      await placeTeamWallets([team1]);
      expect(await crowdfund.getEffectiveCap(team1.address, 1)).to.equal(0);

      await expect(
        crowdfund.launchTeamInvite(team1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      expect(await crowdfund.getEffectiveCap(team1.address, 1)).to.equal(0);
    });

    // WHY: re-placing a team wallet would otherwise multiply its outgoing budget (invitesReceived
    //      × 100); with no stacking the budget stays at 100.
    it("should not scale a team wallet's outgoing budget by re-placement", async function () {
      await placeTeamWallets([team1]);
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(100);

      await expect(crowdfund.launchTeamInvite(team1.address, 0)).to.be.reverted;
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(100);
    });

    it("should allow commit at the hop-2 cap through finalization to claim", async function () {
      const signers = await ethers.getSigners();

      // team1 invites alice to hop-2 (cap $10K); alice commits her full cap
      await placeTeamWallets([team1]);
      await crowdfund.connect(team1).invite(alice.address, 1);
      await crowdfund.connect(alice).commit(2, USDC(10_000));

      // Known contributors bring capped demand above MIN_SALE: 17 × $15K = $255K
      const extraSeeds = signers.slice(10, 27);
      await crowdfund.addSeeds(extraSeeds.map((s: SignerWithAddress) => s.address));
      for (const s of extraSeeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.equal(false);

      // Alice claims ARM — invite → commit → settlement → claim end-to-end
      const armBefore = await armToken.balanceOf(alice.address);
      await crowdfund.connect(alice).claim(alice.address);
      const armAfter = await armToken.balanceOf(alice.address);
      expect(armAfter - armBefore).to.equal(ARM(10_000));
    });
  });

  // ============================================================
  // Re-Invite (Subsequent Invites to Same Node)
  // ============================================================

  describe("Re-Invite", function () {
    it("should revert on second invite to same (address, hop)", async function () {
      await placeTeamWallets([team1, team2]);

      await crowdfund.connect(team1).invite(alice.address, 1);
      // Second invite from a different team wallet — reverts (no stacking)
      await expect(
        crowdfund.connect(team2).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");

      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);
    });

    it("should emit no Invited event for a reverted re-invite", async function () {
      await placeTeamWallets([team1, team2]);

      await crowdfund.connect(team1).invite(alice.address, 1);
      await expect(crowdfund.connect(team2).invite(alice.address, 1)).to.be.reverted;

      // Only the first invite edge was emitted for alice
      const events = await crowdfund.queryFilter(crowdfund.filters.Invited(undefined, alice.address));
      expect(events.length).to.equal(1);
      expect(events[0].args.inviter).to.equal(team1.address);
    });

    it("should not duplicate participantNodes entry on re-invite", async function () {
      await placeTeamWallets([team1, team2]);
      const countBefore = await crowdfund.getParticipantCount();

      await crowdfund.connect(team1).invite(alice.address, 1);
      const countAfterFirst = await crowdfund.getParticipantCount();

      await expect(crowdfund.connect(team2).invite(alice.address, 1)).to.be.reverted;
      const countAfterSecond = await crowdfund.getParticipantCount();

      // Only one new node added (not two)
      expect(countAfterFirst - countBefore).to.equal(1);
      expect(countAfterSecond - countAfterFirst).to.equal(0);
    });

    it("should preserve original invitedBy on re-invite", async function () {
      await placeTeamWallets([team1, team2]);

      await crowdfund.connect(team1).invite(alice.address, 1);
      await expect(crowdfund.connect(team2).invite(alice.address, 1)).to.be.reverted;

      // First inviter is preserved
      expect(await crowdfund.getInviteEdge(alice.address, 2)).to.equal(team1.address);
    });
  });

  // ============================================================
  // Per-Hop Invite-Received Caps
  // ============================================================

  describe("Per-Hop Invite-Received Caps", function () {
    it("hop-1 maxInvitesReceived is 1", async function () {
      await placeTeamWallets([alice]);
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(1);

      await expect(
        crowdfund.launchTeamInvite(alice.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("hop-2 maxInvitesReceived is 1", async function () {
      await placeTeamWallets([team1, team2]);
      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);

      // A second invite (direct or launch-team) should revert
      await expect(
        crowdfund.connect(team2).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      await expect(
        crowdfund.launchTeamInvite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("hop-0 nodes always have invitesReceived=1 (cannot be re-invited)", async function () {
      await setupWithSeeds([seed1]);
      // Hop-0 seeds are added with invitesReceived=1; there is no mechanism to
      // increase it because invite() targets inviterHop+1, so hop-0 can never be the target.
      expect(await crowdfund.getInvitesReceived(seed1.address, 0)).to.equal(1);
    });

    // WHY: invitesReceived is tracked per (address, hop) node. An address at its cap at hop-1
    //      can still receive its one invite at hop-2 (a different node).
    it("different hops enforce their caps independently", async function () {
      await placeTeamWallets([alice, team1]);
      // alice is at its hop-1 cap
      await expect(crowdfund.launchTeamInvite(alice.address, 0)).to.be.revertedWith(
        "ArmadaCrowdfund: max invites received"
      );

      // Meanwhile alice can still receive an invite at hop-2 (different node)
      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(1);
    });
  });

  // ============================================================
  // Multi-Hop Participation
  // ============================================================

  describe("Full Recursive Self-Fill", function () {
    // WHY: recursive self-fill (a seed self-inviting down the tree) is impossible; the multi-hop
    //      participation that remains is a known contributor also placed at hop-2 by the launch
    //      team, committing at both nodes with independent caps ($150K + $10K).
    it("should allow a known contributor placed at hop-2 to commit across both hops", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      // Verify caps
      expect(await crowdfund.getEffectiveCap(seed1.address, 0)).to.equal(USDC(150_000)); // 1 * $150k
      expect(await crowdfund.getEffectiveCap(seed1.address, 1)).to.equal(0);             // not at hop-1
      expect(await crowdfund.getEffectiveCap(seed1.address, 2)).to.equal(USDC(10_000));  // 1 * $10k

      // Commit at both hops
      await crowdfund.connect(seed1).commit(0, USDC(150_000));
      await crowdfund.connect(seed1).commit(2, USDC(10_000));

      // Verify commitments
      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(150_000));
      expect(await crowdfund.getCommitment(seed1.address, 2)).to.equal(USDC(10_000));

      // Total committed
      expect(await crowdfund.totalCommitted()).to.equal(USDC(160_000));
    });
  });

  // ============================================================
  // Independent Nodes
  // ============================================================

  describe("Independent Nodes", function () {
    it("should track uniqueCommitters per-node, not per-address", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      await crowdfund.connect(seed1).commit(0, USDC(100));
      await crowdfund.connect(seed1).commit(2, USDC(100));

      // Each hop should show 1 unique committer
      const [, , committers0] = await crowdfund.getHopStats(0);
      const [, , committers2] = await crowdfund.getHopStats(2);
      expect(committers0).to.equal(1);
      expect(committers2).to.equal(1);
    });

    it("should enforce caps independently per node", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      // Max out hop-0 cap
      await crowdfund.connect(seed1).commit(0, USDC(150_000));
      // Can still commit at hop-2 (independent cap)
      await crowdfund.connect(seed1).commit(2, USDC(10_000));

      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(150_000));
      expect(await crowdfund.getCommitment(seed1.address, 2)).to.equal(USDC(10_000));
    });

    it("should enforce invite budgets independently per node", async function () {
      await placeTeamWallets([team1]);
      // team1 at hop-1 has 100 invites. Use 2 on alice and bob, 1 on itself (hop-2 node).
      await crowdfund.connect(team1).invite(alice.address, 1);
      await crowdfund.connect(team1).invite(bob.address, 1);
      await crowdfund.connect(team1).invite(team1.address, 1);

      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(97);

      // team1 at hop-2 is a separate node with its own (zero) budget
      expect(await crowdfund.getInvitesRemaining(team1.address, 2)).to.equal(0);
    });
  });

  // ============================================================
  // Aggregate Claim
  // ============================================================

  describe("Aggregate Claim", function () {
    // Helper: a successful sale where seed1 holds a hop-0 and a hop-2 node.
    // 79 seeds × $15K = $1.185M plus seed1's $4K at hop-2: under the $1.5M sale, all filled.
    async function setupAndFinalize() {
      const signers = await ethers.getSigners();
      const seeds = signers.slice(1, 80);
      await crowdfund.addSeeds(seeds.map((s: SignerWithAddress) => s.address));

      // seed1 is also placed at hop-2 by the launch team
      await crowdfund.launchTeamInvite(seed1.address, 1);

      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      // seed1 also commits $4k at hop-2
      await fundAndApprove(seed1, USDC(4_000));
      await crowdfund.connect(seed1).commit(2, USDC(4_000));

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.equal(false);
    }

    it("should aggregate ARM from multiple hops in a single claim", async function () {
      await setupAndFinalize();

      const [allocBefore] = await crowdfund.computeAllocation(seed1.address);
      expect(allocBefore).to.equal(ARM(19_000)); // $15K (hop-0) + $4K (hop-2)

      const armBefore = await armToken.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claim(seed1.address);
      const armAfter = await armToken.balanceOf(seed1.address);

      expect(armAfter - armBefore).to.equal(allocBefore);
    });

    it("should revert double-claim", async function () {
      await setupAndFinalize();

      await crowdfund.connect(seed1).claim(seed1.address);

      await expect(
        crowdfund.connect(seed1).claim(seed1.address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });
  });

  // ============================================================
  // Aggregate Refund
  // ============================================================

  describe("Aggregate Refund", function () {
    // WHY: When demand is below MIN_SALE, finalize() enters refundMode.
    // claimRefund() must aggregate the full committed amount across all hops.
    it("should aggregate refund across hops after below-minimum finalize", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed1).commit(2, USDC(4_000));

      // Not enough total → finalize enters refundMode
      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      const usdcBefore = await usdc.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claimRefund();
      const usdcAfter = await usdc.balanceOf(seed1.address);

      // Full $19k refund (both hops)
      expect(usdcAfter - usdcBefore).to.equal(USDC(19_000));
    });

    it("should aggregate refund across hops when canceled", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed1).commit(2, USDC(4_000));

      // securityCouncil (deployer in this test's beforeEach) cancels the crowdfund
      await crowdfund.connect(deployer).cancel();
      expect(await crowdfund.phase()).to.equal(Phase.Canceled);

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

      await crowdfund.launchTeamInvite(seed1.address, 1);
      // seed1 at hop-0 + seed1 at hop-2 = 2 nodes
      expect(await crowdfund.getParticipantCount()).to.equal(2);

      // A reverted re-invite doesn't add a node
      await expect(crowdfund.launchTeamInvite(seed1.address, 1)).to.be.reverted;
      expect(await crowdfund.getParticipantCount()).to.equal(2);
    });

    it("getInviteEdge visible during active sale (no phase restriction)", async function () {
      await placeTeamWallets([team1]);
      await crowdfund.connect(team1).invite(alice.address, 1);

      // Should be readable during Active phase
      const inviter = await crowdfund.getInviteEdge(alice.address, 2);
      expect(inviter).to.equal(team1.address);
    });
  });
});
