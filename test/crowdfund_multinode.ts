// ABOUTME: Tests the (address, hop) node model: multi-hop participation, hop-2 invite stacking,
// ABOUTME: self-invitation by the team wallet, per-node caps and budgets, and aggregate claim/refund.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

// Relaunch layout: hop-0 known contributors ($100K, cannot invite); hop-1 the single team inviter
// wallet ($0 cap, 100 invites); hop-2 invited contributors ($10K per invite, cannot invite). Hop-0 and
// hop-1 take one invite per address; hop-2 stacks up to 20 invites ($200K), from the team wallet
// and/or the launch team's direct hop-2 placements.
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

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  async function setupWithSeeds(seeds: SignerWithAddress[]) {
    await crowdfund.addSeeds(seeds.map(s => s.address));
  }

  // The launch team places the hop-1 team inviter wallet (the only tier that can invite;
  // LAUNCH_TEAM_HOP1_BUDGET = 1, so there is exactly one).
  async function placeTeamWallet(wallet: SignerWithAddress) {
    await crowdfund.launchTeamInvite(wallet.address, 0);
  }

  // The launch team places `addr` directly at hop-2 (or stacks one more invite on it there).
  async function launchTeamHop2(addr: string) {
    await crowdfund.launchTeamInvite(addr, 1);
  }

  async function warpPastWindow() {
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [deployer, seed1, seed2, seed3, alice, bob, treasury, team1] = signers;

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

    await armToken.transfer(cfAddr, ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    for (const signer of [seed1, seed2, seed3, alice, bob, team1]) {
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

    // WHY: the team wallet can stack hop-2 slots on itself like on any invitee, each one costing
    //      one of its 100 hop-1 invites. HOP2_MAX_INVITES_RECEIVED (20) bounds the self-stack at
    //      $200K, and hop-2 has no outgoing invites to recurse further.
    it("should let the team wallet stack self-invitations at hop-2 up to 20, and no more", async function () {
      await placeTeamWallet(team1);

      for (let i = 0; i < 20; i++) {
        await crowdfund.connect(team1).invite(team1.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(team1.address, 2)).to.equal(20);
      expect(await crowdfund.getEffectiveCap(team1.address, 2)).to.equal(USDC(200_000));
      // Each self-invite used one of the team wallet's 100 hop-1 invites
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(80);

      await expect(
        crowdfund.connect(team1).invite(team1.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      expect(await crowdfund.getInvitesReceived(team1.address, 2)).to.equal(20);
      // The reverted 21st self-invite consumed no hop-1 invite
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(80);
      // hop-2 has 0 outgoing invites regardless
      expect(await crowdfund.getInvitesRemaining(team1.address, 2)).to.equal(0);
    });

    // WHY: a self-invite must record the team wallet as its own inviter so the invite graph
    //      reconstructed off-chain stays complete.
    it("should track self-loop edges in invite graph", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(team1.address, 1);

      // First inviter is recorded
      const inviter = await crowdfund.getInviteEdge(team1.address, 2);
      expect(inviter).to.equal(team1.address);
    });
  });

  // ============================================================
  // Caps Scale With Hop-2 Stacking
  // ============================================================

  describe("Invite-Scaling Caps", function () {
    // WHY: a hop-2 contributor's effective cap is invitesReceived × $10K, so a second invite
    //      (here from a different inviter, the launch team) must raise the cap to $20K.
    it("should scale effective cap by $10K per invite: a second invite raises it to $20K", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(10_000));

      await launchTeamHop2(alice.address);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(2);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(20_000));
    });

    // WHY: a commit equal to the single-invite cap is accepted and recorded in full.
    it("should allow commitment up to the cap", async function () {
      await placeTeamWallet(team1);
      await crowdfund.connect(team1).invite(alice.address, 1);

      // Alice can commit up to $10K
      await crowdfund.connect(alice).commit(2, USDC(10_000));
      expect(await crowdfund.getCommitment(alice.address, 2)).to.equal(USDC(10_000));
    });

    // WHY: over-cap deposits are accepted at commit time (the excess is refunded at settlement),
    //      so the raw commitment and hop totals must include the full amount.
    it("should accept commitment exceeding the cap (excess refunded at settlement)", async function () {
      await placeTeamWallet(team1);

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
      await placeTeamWallet(team1);
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
  // Hop-2 Invite Stacking
  // ============================================================

  describe("Invite Stacking Economics", function () {
    // WHY: stacking counts invites, not inviters: invites from the team wallet and the launch team
    //      both land on the same hop-2 node, each adding one slot ($10K) to its effective cap.
    it("should increment invitesReceived on re-invites from different inviters", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(1);

      await launchTeamHop2(alice.address);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(2);

      await crowdfund.connect(team1).invite(alice.address, 1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(3);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(30_000));
    });

    // WHY: HOP2_MAX_INVITES_RECEIVED bounds stacking at 20 slots ($200K) whichever mix of inviters
    //      supplies them; the 21st invite reverts from either inviter and leaves the cap unchanged.
    it("should cap stacking at 20 invites ($200K) across different inviters", async function () {
      await placeTeamWallet(team1);

      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(team1).invite(alice.address, 1);
        await launchTeamHop2(alice.address);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(20);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(200_000));

      await expect(
        crowdfund.connect(team1).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      await expect(
        launchTeamHop2(alice.address)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(200_000));
    });

    // WHY: a repeat launch-team placement of the team wallet at hop-1 must revert, so its $0 cap
    //      cannot be scaled into an allocation. With LAUNCH_TEAM_HOP1_BUDGET = 1 the exhausted
    //      budget stops the re-placement before the maxInvitesReceived (1) check is reached.
    it("should not scale a team wallet's $0 cap by re-placement", async function () {
      await placeTeamWallet(team1);
      expect(await crowdfund.getEffectiveCap(team1.address, 1)).to.equal(0);

      await expect(
        crowdfund.launchTeamInvite(team1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-1 budget exhausted");
      expect(await crowdfund.getEffectiveCap(team1.address, 1)).to.equal(0);
    });

    // WHY: re-placing a team wallet would otherwise multiply its outgoing budget (invitesReceived
    //      × 100); hop-1 takes one invite per address, so the budget stays at 100.
    it("should not scale a team wallet's outgoing budget by re-placement", async function () {
      await placeTeamWallet(team1);
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(100);

      await expect(crowdfund.launchTeamInvite(team1.address, 0)).to.be.reverted;
      expect(await crowdfund.getInvitesRemaining(team1.address, 1)).to.equal(100);
    });

    // WHY: end-to-end check that a stacked cap is honoured at settlement: alice holds two hop-2
    //      slots ($20K) from two inviters, commits the full $20K, and claims 20K ARM.
    it("should allow commit at a stacked hop-2 cap through finalization to claim", async function () {
      const signers = await ethers.getSigners();

      // team1 and the launch team each invite alice to hop-2 (cap 2 × $10K); alice commits her full cap
      await placeTeamWallet(team1);
      await crowdfund.connect(team1).invite(alice.address, 1);
      await launchTeamHop2(alice.address);
      await crowdfund.connect(alice).commit(2, USDC(20_000));

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

      // Alice claims ARM — invite → stack → commit → settlement → claim end-to-end
      const armBefore = await armToken.balanceOf(alice.address);
      await crowdfund.connect(alice).claim(alice.address);
      const armAfter = await armToken.balanceOf(alice.address);
      expect(armAfter - armBefore).to.equal(ARM(20_000));
    });
  });

  // ============================================================
  // Re-Invite (Subsequent Invites to Same Node)
  // ============================================================

  describe("Re-Invite", function () {
    // WHY: a second invite to an existing hop-2 node (from a different inviter) stacks onto it
    //      rather than reverting.
    it("should stack a second invite to the same hop-2 (address, hop)", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(alice.address, 1);
      // Second invite from a different inviter (the launch team) stacks
      await launchTeamHop2(alice.address);

      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(2);
    });

    // WHY: every stacked invite is an edge in the invite graph, so each must emit its own
    //      canonical Invited event with the inviter that issued it.
    it("should emit an Invited event for each stacked re-invite", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(alice.address, 1);
      await launchTeamHop2(alice.address);

      // Both invite edges were emitted for alice, in order
      const events = await crowdfund.queryFilter(crowdfund.filters.Invited(undefined, alice.address));
      expect(events.length).to.equal(2);
      expect(events[0].args.inviter).to.equal(team1.address);
      expect(events[1].args.inviter).to.equal(deployer.address); // launch team
    });

    // WHY: finalize() iterates participantNodes and the node count is capped (MAX_FINALIZE_NODES),
    //      so a stacked re-invite must reuse the existing node, not push a duplicate.
    it("should not duplicate participantNodes entry on re-invite", async function () {
      await placeTeamWallet(team1);
      const countBefore = await crowdfund.getParticipantCount();

      await crowdfund.connect(team1).invite(alice.address, 1);
      const countAfterFirst = await crowdfund.getParticipantCount();

      await launchTeamHop2(alice.address);
      const countAfterSecond = await crowdfund.getParticipantCount();

      // Only one new node added (not two)
      expect(countAfterFirst - countBefore).to.equal(1);
      expect(countAfterSecond - countAfterFirst).to.equal(0);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(2);
    });

    // WHY: invitedBy records the first edge only; a stacked invite from another inviter must not
    //      overwrite it.
    it("should preserve original invitedBy on re-invite", async function () {
      await placeTeamWallet(team1);

      await crowdfund.connect(team1).invite(alice.address, 1);
      await launchTeamHop2(alice.address);

      // First inviter is preserved
      expect(await crowdfund.getInviteEdge(alice.address, 2)).to.equal(team1.address);
    });
  });

  // ============================================================
  // Per-Hop Invite-Received Caps
  // ============================================================

  describe("Per-Hop Invite-Received Caps", function () {
    // WHY: hop-1 takes one invite per address. The only hop-1 placement path is launchTeamInvite,
    //      whose 1-wallet budget is exhausted by the first placement, so a re-placement reverts on
    //      the budget before the maxInvitesReceived check; the constant still pins the cap at 1.
    it("hop-1 maxInvitesReceived is 1 (a re-placement is stopped by the exhausted hop-1 budget)", async function () {
      expect(await crowdfund.HOP1_MAX_INVITES_RECEIVED()).to.equal(1);
      await placeTeamWallet(alice);
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(1);

      await expect(
        crowdfund.launchTeamInvite(alice.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-1 budget exhausted");
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(1);
    });

    // WHY: hop-2 stacks up to 20 invites; the 21st must revert on both invite paths (team wallet
    //      and launch team).
    it("hop-2 maxInvitesReceived is 20", async function () {
      await placeTeamWallet(team1);
      for (let i = 0; i < 20; i++) {
        await crowdfund.connect(team1).invite(alice.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(20);

      // A 21st invite (direct or launch-team) should revert
      await expect(
        crowdfund.connect(team1).invite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      await expect(
        crowdfund.launchTeamInvite(alice.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    // WHY: hop-0 is never an invite target (invites land at inviterHop + 1), so a seed's slot
    //      count is fixed at 1.
    it("hop-0 nodes always have invitesReceived=1 (cannot be re-invited)", async function () {
      await setupWithSeeds([seed1]);
      // Hop-0 seeds are added with invitesReceived=1; there is no mechanism to
      // increase it because invite() targets inviterHop+1, so hop-0 can never be the target.
      expect(await crowdfund.getInvitesReceived(seed1.address, 0)).to.equal(1);
    });

    // WHY: invitesReceived is tracked per (address, hop) node. An address at its 20-invite cap at
    //      hop-2 can still be added as a seed at hop-0 (a different node), and that seed node's
    //      own count is unaffected by the hop-2 stack.
    it("different hops enforce their caps independently", async function () {
      for (let i = 0; i < 20; i++) {
        await launchTeamHop2(alice.address);
      }
      // alice is at its hop-2 cap
      await expect(launchTeamHop2(alice.address)).to.be.revertedWith(
        "ArmadaCrowdfund: max invites received"
      );

      // Meanwhile alice can still be added at hop-0 (different node)
      await setupWithSeeds([alice]);
      expect(await crowdfund.getInvitesReceived(alice.address, 0)).to.equal(1);
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(20);
    });
  });

  // ============================================================
  // Multi-Hop Participation
  // ============================================================

  describe("Full Recursive Self-Fill", function () {
    // WHY: recursive self-fill (a seed self-inviting down the tree) is impossible; the multi-hop
    //      participation that remains is a known contributor also placed at hop-2 by the launch
    //      team, committing at both nodes with independent caps ($100K + $10K).
    it("should allow a known contributor placed at hop-2 to commit across both hops", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      // Verify caps
      expect(await crowdfund.getEffectiveCap(seed1.address, 0)).to.equal(USDC(100_000)); // 1 * $100k
      expect(await crowdfund.getEffectiveCap(seed1.address, 1)).to.equal(0);             // not at hop-1
      expect(await crowdfund.getEffectiveCap(seed1.address, 2)).to.equal(USDC(10_000));  // 1 * $10k

      // Commit at both hops
      await crowdfund.connect(seed1).commit(0, USDC(100_000));
      await crowdfund.connect(seed1).commit(2, USDC(10_000));

      // Verify commitments
      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(100_000));
      expect(await crowdfund.getCommitment(seed1.address, 2)).to.equal(USDC(10_000));

      // Total committed
      expect(await crowdfund.totalCommitted()).to.equal(USDC(110_000));
    });
  });

  // ============================================================
  // Independent Nodes
  // ============================================================

  describe("Independent Nodes", function () {
    // WHY: uniqueCommitters is a per-hop statistic, so one address committing at two nodes counts
    //      once in each hop. The $100 commits sit exactly at MIN_COMMIT.
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

    // WHY: filling the hop-0 cap must not consume the address's separate hop-2 cap.
    it("should enforce caps independently per node", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.launchTeamInvite(seed1.address, 1);

      // Max out hop-0 cap
      await crowdfund.connect(seed1).commit(0, USDC(100_000));
      // Can still commit at hop-2 (independent cap)
      await crowdfund.connect(seed1).commit(2, USDC(10_000));

      expect(await crowdfund.getCommitment(seed1.address, 0)).to.equal(USDC(100_000));
      expect(await crowdfund.getCommitment(seed1.address, 2)).to.equal(USDC(10_000));
    });

    // WHY: the team wallet's hop-1 node holds the 100-invite budget; its hop-2 node (created by a
    //      self-invite) is separate and has a zero budget.
    it("should enforce invite budgets independently per node", async function () {
      await placeTeamWallet(team1);
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
    // 79 seeds × $15K = $1.185M plus seed1's $4K at hop-2: under the $1.8M sale, all filled.
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

    // WHY: claim() sums allocations across all of an address's nodes, so one call must deliver
    //      the hop-0 and hop-2 ARM together.
    it("should aggregate ARM from multiple hops in a single claim", async function () {
      await setupAndFinalize();

      const [allocBefore] = await crowdfund.computeAllocation(seed1.address);
      expect(allocBefore).to.equal(ARM(19_000)); // $15K (hop-0) + $4K (hop-2)

      const armBefore = await armToken.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claim(seed1.address);
      const armAfter = await armToken.balanceOf(seed1.address);

      expect(armAfter - armBefore).to.equal(allocBefore);
    });

    // WHY: a multi-node claimant is marked claimed after the first aggregate claim; a second
    //      claim must not pay out again.
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

    // WHY: a cancelled sale refunds every hop's full commitment, aggregated in one call.
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
    // WHY: the view helpers must report zeros (not revert) for addresses with no node, so UIs can
    //      query any address.
    it("getEffectiveCap returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getEffectiveCap(alice.address, 0)).to.equal(0);
    });

    it("getInvitesReceived returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getInvitesReceived(alice.address, 0)).to.equal(0);
    });

    it("getInvitesRemaining returns 0 for non-whitelisted node", async function () {
      expect(await crowdfund.getInvitesRemaining(alice.address, 0)).to.equal(0);
    });

    // WHY: the participant count is the finalize() iteration length, so it counts (address, hop)
    //      nodes, not addresses or invites.
    it("getParticipantCount reflects unique (address, hop) nodes", async function () {
      await setupWithSeeds([seed1]);
      expect(await crowdfund.getParticipantCount()).to.equal(1);

      await crowdfund.launchTeamInvite(seed1.address, 1);
      // seed1 at hop-0 + seed1 at hop-2 = 2 nodes
      expect(await crowdfund.getParticipantCount()).to.equal(2);

      // A stacked re-invite doesn't add a node
      await crowdfund.launchTeamInvite(seed1.address, 1);
      expect(await crowdfund.getInvitesReceived(seed1.address, 2)).to.equal(2);
      expect(await crowdfund.getParticipantCount()).to.equal(2);
    });

    // WHY: the invite graph is public during the sale so participants can see who invited them.
    it("getInviteEdge visible during active sale (no phase restriction)", async function () {
      await placeTeamWallet(team1);
      await crowdfund.connect(team1).invite(alice.address, 1);

      // Should be readable during Active phase
      const inviter = await crowdfund.getInviteEdge(alice.address, 2);
      expect(inviter).to.equal(team1.address);
    });
  });
});
