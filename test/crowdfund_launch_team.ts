// ABOUTME: Tests for the launch team sentinel invite mechanism and seed cap.
// ABOUTME: Covers budget limits, timing window, re-invite behavior, and constructor validation.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Phase enum (must match IArmadaCrowdfund.sol)
const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

// Time constants
const ONE_DAY = 86400;

// USDC amounts (6 decimals)
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

describe("Launch Team & Seed Cap", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress; // also launchTeam for testing
  let treasury: SignerWithAddress;
  let outsider: SignerWithAddress;
  let securityCouncil: SignerWithAddress;
  let allSigners: SignerWithAddress[];

  // Generate deterministic addresses for bulk operations
  function makeAddresses(count: number, startIndex: number = 100): string[] {
    const addrs: string[] = [];
    for (let i = 0; i < count; i++) {
      // Deterministic non-zero addresses
      addrs.push(ethers.zeroPadValue(ethers.toBeHex(startIndex + i), 20));
    }
    return addrs;
  }

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    [deployer, treasury, outsider] = allSigners;
    securityCouncil = allSigners[10];

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
      treasury.address,   // treasury
      deployer.address,   // launchTeam
      securityCouncil.address, // securityCouncil
      openTimestamp        // openTimestamp
    );
    await crowdfund.waitForDeployment();

    // Fund ARM for MAX_SALE and verify pre-load
    const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
    await armToken.transfer(await crowdfund.getAddress(), ARM(1_800_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
  });

  // ============ 500-Seed Cap ============

  describe("500-Seed Cap", function () {
    // WHY: MAX_SEEDS (500) exceeds uint8, so the widened type must admit exactly 500.
    it("allows up to 500 seeds", async function () {
      const seeds = makeAddresses(500);
      // Add in batches to avoid gas limits
      for (let i = 0; i < 500; i += 50) {
        await crowdfund.addSeeds(seeds.slice(i, Math.min(i + 50, 500)));
      }
      const stats = await crowdfund.getHopStats(0);
      expect(stats._whitelistCount).to.equal(500);
    });

    it("reverts on 501st seed", async function () {
      const seeds = makeAddresses(500);
      for (let i = 0; i < 500; i += 50) {
        await crowdfund.addSeeds(seeds.slice(i, Math.min(i + 50, 500)));
      }
      const extraSeed = makeAddresses(1, 9_999);
      await expect(
        crowdfund.addSeed(extraSeed[0])
      ).to.be.revertedWith("ArmadaCrowdfund: seed cap reached");
    });

    it("reverts mid-batch when cap would be exceeded", async function () {
      // Add 498 first
      const seeds498 = makeAddresses(498);
      for (let i = 0; i < 498; i += 50) {
        await crowdfund.addSeeds(seeds498.slice(i, Math.min(i + 50, 498)));
      }
      // Try to add 5 more (only 2 slots remain)
      const seeds5 = makeAddresses(5, 5_000);
      await expect(
        crowdfund.addSeeds(seeds5)
      ).to.be.revertedWith("ArmadaCrowdfund: seed cap reached");
    });
  });

  // ============ Launch Team Sentinel ============

  describe("Launch Team Invite Basics", function () {
    let invitee1: SignerWithAddress;
    let invitee2: SignerWithAddress;
    let seed1: SignerWithAddress;

    beforeEach(async function () {
      [, , , invitee1, invitee2, seed1] = allSigners;
      // Add a seed and start the active window
      await crowdfund.addSeed(seed1.address);

    });

    it("launch team can invite to hop-1", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      expect(await crowdfund.isWhitelisted(invitee1.address, 1)).to.be.true;
    });

    it("launch team can invite to hop-2", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 1);
      expect(await crowdfund.isWhitelisted(invitee1.address, 2)).to.be.true;
    });

    it("reverts if fromHop >= 2 (only 0 and 1 are valid)", async function () {
      await expect(
        crowdfund.launchTeamInvite(invitee1.address, 2)
      ).to.be.revertedWith("ArmadaCrowdfund: invalid hop for launch team");
    });

    it("reverts if fromHop > 2", async function () {
      await expect(
        crowdfund.launchTeamInvite(invitee1.address, 3)
      ).to.be.reverted;
    });

    it("reverts if caller is not launch team", async function () {
      await expect(
        crowdfund.connect(outsider).launchTeamInvite(invitee1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: not launch team");
    });

    it("reverts if invitee is zero address", async function () {
      await expect(
        crowdfund.launchTeamInvite(ethers.ZeroAddress, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: zero address");
    });

    it("reverts after invite window closes", async function () {
      // Advance past the launch team invite window (which spans the full commitment window)
      await time.increaseTo((await crowdfund.launchTeamInviteEnd()) + 1n);
      await expect(
        crowdfund.launchTeamInvite(invitee1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("invite graph shows launch team as inviter", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      const inviter = await crowdfund.getInviteEdge(invitee1.address, 1);
      expect(inviter).to.equal(deployer.address); // launchTeam == deployer in test
    });

    it("hop-1 invitee (team inviter wallet) has 100 hop-2 invite slots", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      // invitee1 is hop-1, should be able to invite 100 hop-2 addresses
      const remaining = await crowdfund.getInvitesRemaining(invitee1.address, 1);
      expect(remaining).to.equal(100);
    });

    it("hop-1 invitee can use their invite slots normally", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      // invitee1 invites invitee2 to hop-2
      await crowdfund.connect(invitee1).invite(invitee2.address, 1);
      expect(await crowdfund.isWhitelisted(invitee2.address, 2)).to.be.true;
    });

    it("hop-2 invitee cannot invite (maxInvites = 0)", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 1);
      // hop-2 has maxInvites = 0, so inviterHop must be < NUM_HOPS - 1
      await expect(
        crowdfund.connect(invitee1).invite(invitee2.address, 2)
      ).to.be.revertedWith("ArmadaCrowdfund: max hop reached");
    });

    it("whitelistCount increments correctly for launch team invites", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      await crowdfund.launchTeamInvite(invitee2.address, 1);
      const hop1Stats = await crowdfund.getHopStats(1);
      const hop2Stats = await crowdfund.getHopStats(2);
      expect(hop1Stats._whitelistCount).to.equal(1);
      expect(hop2Stats._whitelistCount).to.equal(1);
    });

    // WHY: Issue #236 — canonical Invited(inviter, invitee, hop, nonce) must
    // cover launch-team issuance too, so an observer can reconstruct the full
    // invite graph from a single event type (inviter = launchTeam, nonce = 0).
    it("emits canonical Invited(launchTeam, invitee, hop, 0)", async function () {
      await expect(crowdfund.launchTeamInvite(invitee1.address, 0))
        .to.emit(crowdfund, "Invited")
        .withArgs(deployer.address, invitee1.address, 1, 0);

      await expect(crowdfund.launchTeamInvite(invitee2.address, 1))
        .to.emit(crowdfund, "Invited")
        .withArgs(deployer.address, invitee2.address, 2, 0);
    });

    // WHY: Issue #236 — LaunchTeamInvited is retained as a supplementary event
    // for UI/analytics consumers; assert both are emitted in one call.
    it("still emits supplementary LaunchTeamInvited alongside Invited", async function () {
      const tx = await crowdfund.launchTeamInvite(invitee1.address, 0);
      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(deployer.address, invitee1.address, 1, 0);
      await expect(tx)
        .to.emit(crowdfund, "LaunchTeamInvited")
        .withArgs(invitee1.address, 1);
    });
  });

  // WHY: Issue #236 — launch-team invite issuance belongs to the armed sale
  // flow. Without this guard, launch team could seed invite-graph nodes
  // before ARM preload has been verified, breaking the intended sequencing
  // (addSeed already enforces this; launchTeamInvite must match).
  describe("armLoaded Guard", function () {
    it("reverts when ARM has not been loaded", async function () {
      // Deploy a fresh crowdfund WITHOUT calling loadArm()
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const openTs = (await time.latest()) + 300;
      const cf = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        treasury.address,
        deployer.address,
        securityCouncil.address,
        openTs
      );
      await cf.waitForDeployment();

      // Fund ARM but intentionally skip loadArm() to exercise the guard
      const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
      await armToken.transfer(await cf.getAddress(), ARM(1_800_000));
      await time.increaseTo(await cf.windowStart());

      await expect(
        cf.launchTeamInvite(allSigners[4].address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM not loaded");
    });

    it("succeeds once loadArm() is called", async function () {
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const openTs = (await time.latest()) + 300;
      const cf = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        treasury.address,
        deployer.address,
        securityCouncil.address,
        openTs
      );
      await cf.waitForDeployment();

      const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
      await armToken.transfer(await cf.getAddress(), ARM(1_800_000));
      await cf.loadArm();
      await time.increaseTo(await cf.windowStart());

      await cf.launchTeamInvite(allSigners[4].address, 0);
      expect(await cf.isWhitelisted(allSigners[4].address, 1)).to.be.true;
    });
  });

  describe("Budget Exhaustion", function () {
    beforeEach(async function () {
      await crowdfund.addSeed(allSigners[3].address);

    });

    // WHY: LAUNCH_TEAM_HOP1_BUDGET is 1: the launch team places exactly one hop-1 team inviter
    //      wallet, and that placement must not touch the hop-2 budget.
    it("allows exactly 1 hop-1 invite (the team inviter wallet)", async function () {
      const [addr] = makeAddresses(1);
      await crowdfund.launchTeamInvite(addr, 0);
      const [hop1Rem, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop1Rem).to.equal(0);
      expect(hop2Rem).to.equal(500);
    });

    // WHY: a second team inviter wallet would add another 100 hop-2 invites outside the planned
    //      budget, so the 2nd hop-1 placement must revert.
    it("2nd hop-1 invite reverts", async function () {
      const addrs = makeAddresses(2);
      await crowdfund.launchTeamInvite(addrs[0], 0);
      await expect(
        crowdfund.launchTeamInvite(addrs[1], 0)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-1 budget exhausted");
    });

    // WHY: LAUNCH_TEAM_HOP2_BUDGET (500) exceeds uint8; the widened budget and counter must
    //      admit exactly 500 placements.
    it("allows exactly 500 hop-2 invites", async function () {
      const addrs = makeAddresses(500);
      for (const addr of addrs) {
        await crowdfund.launchTeamInvite(addr, 1);
      }
      const [hop1Rem, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop1Rem).to.equal(1);
      expect(hop2Rem).to.equal(0);
    });

    // WHY: the hop-2 budget bounds launch-team placements (and so the finalize() node count);
    //      the 501st must revert.
    it("501st hop-2 invite reverts", async function () {
      const addrs = makeAddresses(501);
      for (let i = 0; i < 500; i++) {
        await crowdfund.launchTeamInvite(addrs[i], 1);
      }
      await expect(
        crowdfund.launchTeamInvite(addrs[500], 1)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-2 budget exhausted");
    });

    // WHY: the admin UI reads remaining budgets from this view; each placement must decrement
    //      only its own hop's budget.
    it("getLaunchTeamBudgetRemaining tracks correctly", async function () {
      // Initial state
      let [h1, h2] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(h1).to.equal(1);
      expect(h2).to.equal(500);

      // Use some
      await crowdfund.launchTeamInvite(makeAddresses(1, 199)[0], 0);
      await crowdfund.launchTeamInvite(makeAddresses(1, 299)[0], 1);
      await crowdfund.launchTeamInvite(makeAddresses(1, 300)[0], 1);

      [h1, h2] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(h1).to.equal(0);
      expect(h2).to.equal(498);
    });
  });

  describe("Launch-Team Invite Window Timing", function () {
    beforeEach(async function () {
      await crowdfund.addSeed(allSigners[3].address);

    });

    // WHY: The launch-team invite window spans the whole commitment window. Pinning the two
    // timestamps together catches any constant change that would reintroduce a period at the
    // end of the sale in which the launch team can no longer act.
    it("launch team invite window ends at the commitment window end", async function () {
      expect(await crowdfund.launchTeamInviteEnd()).to.equal(await crowdfund.windowEnd());
    });

    // WHY: the launch team can place participants at any point inside the window, not only at open.
    it("launch team invite mid-window (day 2) succeeds", async function () {
      await time.increase(2 * ONE_DAY);
      await crowdfund.launchTeamInvite(allSigners[4].address, 0);
      expect(await crowdfund.isWhitelisted(allSigners[4].address, 1)).to.be.true;
    });

    // WHY: The launch-team window spans the full 5-day sale, so a placement on the final day
    // must still succeed.
    it("launch team invite on the final day (day 4) succeeds", async function () {
      await time.increase(4 * ONE_DAY);
      await crowdfund.launchTeamInvite(allSigners[4].address, 0);
      expect(await crowdfund.isWhitelisted(allSigners[4].address, 1)).to.be.true;
    });

    it("launch team invite at exactly windowEnd reverts (boundary)", async function () {
      // WHY: The launch-team check is strict (`< launchTeamInviteEnd`) while participant
      // invites and commits allow `<= windowEnd`. At exactly windowEnd the launch team is
      // already closed out; pins the boundary so the asymmetry is deliberate, not accidental.
      await time.setNextBlockTimestamp(await crowdfund.windowEnd());
      await expect(
        crowdfund.launchTeamInvite(allSigners[4].address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("team-wallet invites still work at windowEnd, after the launch-team window closes", async function () {
      // WHY: Participant invites (from hop-1 team wallets, the only tier that can invite) are
      // open through the full active window, including the final second (windowEnd), which is
      // the one moment the launch-team window is already closed.
      const teamWallet = allSigners[5];
      await crowdfund.launchTeamInvite(teamWallet.address, 0);
      await time.setNextBlockTimestamp(await crowdfund.windowEnd());
      await crowdfund.connect(teamWallet).invite(allSigners[4].address, 1);
      expect(await crowdfund.isWhitelisted(allSigners[4].address, 2)).to.be.true;
    });
  });

  describe("Re-Invite Behavior", function () {
    let invitee: SignerWithAddress;

    beforeEach(async function () {
      invitee = allSigners[4];
      await crowdfund.addSeed(allSigners[3].address);

    });

    // WHY: hop-2 stacks (maxInvitesReceived 20). A launch-team re-invite of the same hop-2
    //      (address, hop) must increment invitesReceived on the existing node, and each stacked
    //      placement spends one slot of the hop-2 budget.
    it("re-invite to same hop-2 (address, hop) stacks invitesReceived", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 1);
      expect(await crowdfund.getInvitesReceived(invitee.address, 2)).to.equal(1);

      await crowdfund.launchTeamInvite(invitee.address, 1);
      expect(await crowdfund.getInvitesReceived(invitee.address, 2)).to.equal(2);

      const [, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop2Rem).to.equal(498); // 500 - 2
    });

    // WHY: the budget is decremented before the stacking check, so a re-invite that reverts at
    //      the 20-invite cap must roll back its budget decrement too.
    it("a reverted re-invite does not consume budget", async function () {
      for (let i = 0; i < 20; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 1);
      }
      await expect(crowdfund.launchTeamInvite(invitee.address, 1)).to.be.reverted;

      const [, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop2Rem).to.equal(480); // 500 - 20
    });

    // WHY: a hop-2 effective cap is invitesReceived × $10K, so each stacked launch-team placement
    //      adds $10K, up to $200K at 20; the 21st reverts and leaves the cap unchanged.
    it("each hop-2 re-invite scales effective cap by $10K, up to $200K", async function () {
      for (let i = 1; i <= 20; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 1);
        expect(await crowdfund.getEffectiveCap(invitee.address, 2)).to.equal(USDC(10_000 * i));
      }

      await expect(crowdfund.launchTeamInvite(invitee.address, 1)).to.be.reverted;
      expect(await crowdfund.getEffectiveCap(invitee.address, 2)).to.equal(USDC(200_000));
    });

    // WHY: re-placing the team wallet would otherwise multiply its outgoing budget
    //      (invitesReceived × 100); hop-1 takes one invite per address, so it stays at 100.
    it("re-invite cannot scale outgoing invite budget", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesRemaining(invitee.address, 1)).to.equal(100);

      await expect(crowdfund.launchTeamInvite(invitee.address, 0)).to.be.reverted;
      expect(await crowdfund.getInvitesRemaining(invitee.address, 1)).to.equal(100);
    });

    // WHY: hop-1 maxInvitesReceived is 1, but launchTeamInvite checks and spends the 1-wallet
    //      hop-1 budget before the stacking check, so a hop-1 re-placement reverts on the budget.
    //      Either way the team wallet cannot hold a second hop-1 slot.
    it("hop-1 re-invite reverts on the exhausted hop-1 budget (maxInvitesReceived = 1)", async function () {
      expect(await crowdfund.HOP1_MAX_INVITES_RECEIVED()).to.equal(1);
      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesReceived(invitee.address, 1)).to.equal(1);

      // 2nd invite should revert
      await expect(
        crowdfund.launchTeamInvite(invitee.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-1 budget exhausted");
      expect(await crowdfund.getInvitesReceived(invitee.address, 1)).to.equal(1);
    });

    // WHY: pins HOP2_MAX_INVITES_RECEIVED at 20 through the launch-team path: the 20th placement
    //      succeeds and the 21st reverts with the stacking-cap reason.
    it("re-invite capped at per-hop maxInvitesReceived (hop-2 = 20)", async function () {
      for (let i = 0; i < 20; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(invitee.address, 2)).to.equal(20);

      // 21st invite should revert
      await expect(
        crowdfund.launchTeamInvite(invitee.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    // WHY: off-chain consumers count LaunchTeamInvited events per invitee; each stacked placement
    //      must emit one, and a reverted placement past the cap must emit none.
    it("each stacked re-invite emits LaunchTeamInvited; a reverted one emits none", async function () {
      for (let i = 0; i < 20; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 1);
      }
      await expect(crowdfund.launchTeamInvite(invitee.address, 1))
        .to.be.revertedWith("ArmadaCrowdfund: max invites received");
      const events = await crowdfund.queryFilter(crowdfund.filters.LaunchTeamInvited(invitee.address));
      expect(events.length).to.equal(20);
    });
  });

  describe("Constructor Validation", function () {
    it("rejects zero launchTeam address", async function () {
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const cvOpenTimestamp = (await time.latest()) + 300;
      await expect(
        ArmadaCrowdfund.deploy(
          await usdc.getAddress(),
          await armToken.getAddress(),
          treasury.address,
          ethers.ZeroAddress,
          deployer.address,
          cvOpenTimestamp
        )
      ).to.be.revertedWith("ArmadaCrowdfund: zero launchTeam");
    });
  });
});
