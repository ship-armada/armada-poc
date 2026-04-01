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
const ONE_WEEK = 7 * ONE_DAY;
const THREE_WEEKS = 21 * ONE_DAY;

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

  // ============ 150-Seed Cap ============

  describe("150-Seed Cap", function () {
    it("allows up to 150 seeds", async function () {
      const seeds = makeAddresses(150);
      // Add in batches to avoid gas limits
      for (let i = 0; i < 150; i += 50) {
        await crowdfund.addSeeds(seeds.slice(i, i + 50));
      }
      const stats = await crowdfund.getHopStats(0);
      expect(stats._whitelistCount).to.equal(150);
    });

    it("reverts on 151st seed", async function () {
      const seeds = makeAddresses(150);
      for (let i = 0; i < 150; i += 50) {
        await crowdfund.addSeeds(seeds.slice(i, i + 50));
      }
      const extraSeed = makeAddresses(1, 999);
      await expect(
        crowdfund.addSeed(extraSeed[0])
      ).to.be.revertedWith("ArmadaCrowdfund: seed cap reached");
    });

    it("reverts mid-batch when cap would be exceeded", async function () {
      // Add 148 first
      const seeds148 = makeAddresses(148);
      for (let i = 0; i < 148; i += 50) {
        await crowdfund.addSeeds(seeds148.slice(i, Math.min(i + 50, 148)));
      }
      // Try to add 5 more (only 2 slots remain)
      const seeds5 = makeAddresses(5, 500);
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
      // Advance past the 7-day launch team invite window
      await time.increase(7 * ONE_DAY + 1);
      await expect(
        crowdfund.launchTeamInvite(invitee1.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("invite graph shows launch team as inviter", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      const inviter = await crowdfund.getInviteEdge(invitee1.address, 1);
      expect(inviter).to.equal(deployer.address); // launchTeam == deployer in test
    });

    it("hop-1 invitee has standard 2 hop-2 invite slots", async function () {
      await crowdfund.launchTeamInvite(invitee1.address, 0);
      // invitee1 is hop-1, should be able to invite 2 hop-2 addresses
      const remaining = await crowdfund.getInvitesRemaining(invitee1.address, 1);
      expect(remaining).to.equal(2);
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
  });

  describe("Budget Exhaustion", function () {
    beforeEach(async function () {
      await crowdfund.addSeed(allSigners[3].address);

    });

    it("allows exactly 60 hop-1 invites", async function () {
      const addrs = makeAddresses(60);
      for (const addr of addrs) {
        await crowdfund.launchTeamInvite(addr, 0);
      }
      const [hop1Rem, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop1Rem).to.equal(0);
      expect(hop2Rem).to.equal(60);
    });

    it("61st hop-1 invite reverts", async function () {
      const addrs = makeAddresses(61);
      for (let i = 0; i < 60; i++) {
        await crowdfund.launchTeamInvite(addrs[i], 0);
      }
      await expect(
        crowdfund.launchTeamInvite(addrs[60], 0)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-1 budget exhausted");
    });

    it("allows exactly 60 hop-2 invites", async function () {
      const addrs = makeAddresses(60);
      for (const addr of addrs) {
        await crowdfund.launchTeamInvite(addr, 1);
      }
      const [hop1Rem, hop2Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop1Rem).to.equal(60);
      expect(hop2Rem).to.equal(0);
    });

    it("61st hop-2 invite reverts", async function () {
      const addrs = makeAddresses(61);
      for (let i = 0; i < 60; i++) {
        await crowdfund.launchTeamInvite(addrs[i], 1);
      }
      await expect(
        crowdfund.launchTeamInvite(addrs[60], 1)
      ).to.be.revertedWith("ArmadaCrowdfund: hop-2 budget exhausted");
    });

    it("getLaunchTeamBudgetRemaining tracks correctly", async function () {
      // Initial state
      let [h1, h2] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(h1).to.equal(60);
      expect(h2).to.equal(60);

      // Use some
      await crowdfund.launchTeamInvite(makeAddresses(1, 199)[0], 0);
      await crowdfund.launchTeamInvite(makeAddresses(1, 299)[0], 1);
      await crowdfund.launchTeamInvite(makeAddresses(1, 300)[0], 1);

      [h1, h2] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(h1).to.equal(59);
      expect(h2).to.equal(58);
    });
  });

  describe("7-Day Invite Window Timing", function () {
    beforeEach(async function () {
      await crowdfund.addSeed(allSigners[3].address);

    });

    it("launch team invite on day 6 succeeds", async function () {
      await time.increase(6 * ONE_DAY);
      await crowdfund.launchTeamInvite(allSigners[4].address, 0);
      expect(await crowdfund.isWhitelisted(allSigners[4].address, 1)).to.be.true;
    });

    it("launch team invite on day 8 reverts (past week 1)", async function () {
      await time.increase(7 * ONE_DAY + 1);
      await expect(
        crowdfund.launchTeamInvite(allSigners[4].address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("launch team invite at exactly 7 days reverts (boundary)", async function () {
      // At exactly windowStart + 7 days, the condition is NOT strictly less than
      await time.increase(7 * ONE_DAY);
      await expect(
        crowdfund.launchTeamInvite(allSigners[4].address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    it("regular seed invites still work after week 1", async function () {
      // Seeds can invite throughout the full active window
      await time.increase(10 * ONE_DAY);
      const seed = allSigners[3];
      await crowdfund.connect(seed).invite(allSigners[4].address, 0);
      expect(await crowdfund.isWhitelisted(allSigners[4].address, 1)).to.be.true;
    });
  });

  describe("Launch Team Cannot Commit", function () {
    beforeEach(async function () {
      await crowdfund.addSeed(allSigners[3].address);

    });

    it("launch team address cannot commit USDC", async function () {
      // Even if somehow whitelisted (e.g., added as seed), commit should revert
      // In practice, deployer == launchTeam == admin in this test, and deployer
      // is not a seed, but let's test the guard directly.
      // First, make the launchTeam address a seed-like participant manually
      // by deploying a separate crowdfund where launchTeam is a different address
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const ltSigner = allSigners[5];
      const cfOpenTimestamp = (await time.latest()) + 300;
      const cf = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        treasury.address,
        ltSigner.address,         // separate launch team
        securityCouncil.address,  // securityCouncil
        cfOpenTimestamp      // openTimestamp
      );
      await cf.waitForDeployment();

      // Fund ARM and verify pre-load
      const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);
      await armToken.transfer(await cf.getAddress(), ARM(1_800_000));
      await cf.loadArm();

      // Advance to window start, then add launchTeam as a seed
      await time.increaseTo(await cf.windowStart());
      await cf.connect(ltSigner).addSeed(ltSigner.address);

      // Fund the launch team address
      await fundAndApprove(ltSigner, USDC(15000));

      // Try to commit — should be blocked by launch team guard
      await expect(
        cf.connect(ltSigner).commit(0, USDC(100))
      ).to.be.revertedWith("ArmadaCrowdfund: launch team cannot commit");
    });
  });

  describe("Re-Invite Behavior", function () {
    let invitee: SignerWithAddress;

    beforeEach(async function () {
      invitee = allSigners[4];
      await crowdfund.addSeed(allSigners[3].address);

    });

    it("re-invite to same (address, hop) increments invitesReceived", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesReceived(invitee.address, 1)).to.equal(1);

      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesReceived(invitee.address, 1)).to.equal(2);
    });

    it("re-invite consumes budget", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      await crowdfund.launchTeamInvite(invitee.address, 0);

      const [hop1Rem] = await crowdfund.getLaunchTeamBudgetRemaining();
      expect(hop1Rem).to.equal(58); // 60 - 2
    });

    it("re-invite scales effective cap", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      let cap = await crowdfund.getEffectiveCap(invitee.address, 1);
      expect(cap).to.equal(USDC(4000)); // 1 × $4k

      await crowdfund.launchTeamInvite(invitee.address, 0);
      cap = await crowdfund.getEffectiveCap(invitee.address, 1);
      expect(cap).to.equal(USDC(8000)); // 2 × $4k
    });

    it("re-invite scales outgoing invite budget", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesRemaining(invitee.address, 1)).to.equal(2);

      await crowdfund.launchTeamInvite(invitee.address, 0);
      expect(await crowdfund.getInvitesRemaining(invitee.address, 1)).to.equal(4); // 2 × 2
    });

    it("re-invite capped at per-hop maxInvitesReceived (hop-1 = 10)", async function () {
      // Hop-1 cap is 10 — invite 10 times (uses 10 budget slots)
      for (let i = 0; i < 10; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 0);
      }
      expect(await crowdfund.getInvitesReceived(invitee.address, 1)).to.equal(10);

      // 11th re-invite should revert
      await expect(
        crowdfund.launchTeamInvite(invitee.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("re-invite capped at per-hop maxInvitesReceived (hop-2 = 20)", async function () {
      // Hop-2 cap is 20 — invite 20 times (uses 20 budget slots)
      for (let i = 0; i < 20; i++) {
        await crowdfund.launchTeamInvite(invitee.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(invitee.address, 2)).to.equal(20);

      // 21st re-invite should revert
      await expect(
        crowdfund.launchTeamInvite(invitee.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
    });

    it("emits LaunchTeamInvited on re-invite", async function () {
      await crowdfund.launchTeamInvite(invitee.address, 0);
      await expect(crowdfund.launchTeamInvite(invitee.address, 0))
        .to.emit(crowdfund, "LaunchTeamInvited")
        .withArgs(invitee.address, 1);
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
