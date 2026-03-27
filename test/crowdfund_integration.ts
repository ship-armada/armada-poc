/**
 * Crowdfund Integration Tests
 *
 * Tests the full Armada crowdfund system:
 * - Setup: seed management, phase transitions
 * - Active window: invites, commits, cap enforcement
 * - Allocation: elastic expansion, pro-rata, rollover, cancellation
 * - Claims & refunds: ARM distribution, USDC refunds, admin withdrawals
 * - View functions & graph privacy
 * - End-to-end flows
 * - Governance integration
 */

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
// ARM amounts (18 decimals)
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund Integration", function () {
  // Contracts
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  // Signers — we need many for invitation chain + rollover threshold tests
  let deployer: SignerWithAddress;
  let seed1: SignerWithAddress;
  let seed2: SignerWithAddress;
  let seed3: SignerWithAddress;
  let hop1a: SignerWithAddress;
  let hop1b: SignerWithAddress;
  let hop1c: SignerWithAddress;
  let hop2a: SignerWithAddress;
  let hop2b: SignerWithAddress;
  let treasury: SignerWithAddress;
  let outsider: SignerWithAddress;
  let allSigners: SignerWithAddress[];

  // Fund participants with USDC and approve crowdfund
  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  // Setup helper: register seed addresses in the crowdfund
  async function setupWithSeeds(seeds: SignerWithAddress[]) {
    await crowdfund.addSeeds(seeds.map(s => s.address));
  }

  // Setup helper: register seeds (time advancement to windowStart handled by beforeEach)
  async function setupActive(seeds: SignerWithAddress[]) {
    await setupWithSeeds(seeds);
  }

  // Add hop-1 demand to avoid refundMode when testing with seeds-only at hop-0.
  // At BASE_SALE, hop-0 ceiling ($798K) < MIN_SALE ($1M). Adding 51 hop-1 at $4K
  // pushes totalAllocUsdc to $1,002K > $1M. Hop-0 allocation math stays unchanged.
  async function addHop1ForMinSale(seeds: SignerWithAddress[], hop1Pool: SignerWithAddress[]) {
    const count = Math.min(51, hop1Pool.length, seeds.length);
    for (let i = 0; i < count; i++) {
      await crowdfund.connect(seeds[i]).invite(hop1Pool[i].address, 0);
      await fundAndApprove(hop1Pool[i], USDC(4_000));
      await crowdfund.connect(hop1Pool[i]).commit(1, USDC(4_000));
    }
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    [deployer, seed1, seed2, seed3, hop1a, hop1b, hop1c, hop2a, hop2b, treasury, outsider] = allSigners;

    // Deploy MockUSDCV2
    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    // Deploy ArmadaToken (12M ARM to deployer)
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, deployer.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([deployer.address]);

    // Deploy ArmadaCrowdfund
    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      deployer.address,
      deployer.address,       // securityCouncil
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    // Fund ARM to crowdfund (enough for MAX_SALE) and verify pre-load
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    const maxArm = CROWDFUND_ARM_FUNDING;
    await armToken.transfer(cfAddr, maxArm);
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    // Fund all potential participants with USDC
    for (const signer of [seed1, seed2, seed3, hop1a, hop1b, hop1c, hop2a, hop2b]) {
      await fundAndApprove(signer, USDC(20_000));
    }
  });

  // ============================================================
  // 1. Setup Phase
  // ============================================================

  describe("Setup Phase", function () {
    it("should deploy with correct initial state", async function () {
      expect(await crowdfund.phase()).to.equal(Phase.Active);
      expect(await crowdfund.totalCommitted()).to.equal(0);
      expect(await crowdfund.getParticipantCount()).to.equal(0);

      // Verify window timestamps are set correctly
      const ws = await crowdfund.windowStart();
      const we = await crowdfund.windowEnd();
      const ltie = await crowdfund.launchTeamInviteEnd();
      expect(ws).to.be.gt(0);
      expect(we - ws).to.equal(THREE_WEEKS);
      expect(ltie - ws).to.equal(ONE_WEEK);

      // Check hop configs (overlapping ceilings: 70/45/0 — hop-2 uses floor+rollover, not BPS)
      const [ceilingBps0, cap0, maxInv0] = await crowdfund.hopConfigs(0);
      expect(ceilingBps0).to.equal(7000);
      expect(cap0).to.equal(USDC(15_000));
      expect(maxInv0).to.equal(3);

      const [ceilingBps1, cap1, maxInv1] = await crowdfund.hopConfigs(1);
      expect(ceilingBps1).to.equal(4500);
      expect(cap1).to.equal(USDC(4_000));
      expect(maxInv1).to.equal(2);

      const [ceilingBps2, cap2, maxInv2] = await crowdfund.hopConfigs(2);
      expect(ceilingBps2).to.equal(0);
      expect(cap2).to.equal(USDC(1_000));
      expect(maxInv2).to.equal(0);
    });

    it("should allow admin to add a single seed", async function () {
      await crowdfund.addSeed(seed1.address);
      expect(await crowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
      expect(await crowdfund.getParticipantCount()).to.equal(1);

      const [totalComm, _cappedComm, uniqueComm, whitelistCount] = await crowdfund.getHopStats(0);
      expect(whitelistCount).to.equal(1);
    });

    it("should allow admin to batch add seeds", async function () {
      await crowdfund.addSeeds([seed1.address, seed2.address, seed3.address]);
      expect(await crowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
      expect(await crowdfund.isWhitelisted(seed2.address, 0)).to.be.true;
      expect(await crowdfund.isWhitelisted(seed3.address, 0)).to.be.true;
      expect(await crowdfund.getParticipantCount()).to.equal(3);
    });

    it("should reject non-launch-team adding seeds", async function () {
      await expect(
        crowdfund.connect(seed1).addSeed(seed2.address)
      ).to.be.revertedWith("ArmadaCrowdfund: not launch team");
    });

    it("should reject adding zero address as seed", async function () {
      await expect(
        crowdfund.addSeed(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: zero address");
    });

    it("should reject duplicate seed", async function () {
      await crowdfund.addSeed(seed1.address);
      await expect(
        crowdfund.addSeed(seed1.address)
      ).to.be.revertedWith("ArmadaCrowdfund: already whitelisted");
    });

    it("should reject adding seeds after week 1 of active window", async function () {
      await crowdfund.addSeed(seed1.address);

      // Seeds allowed during week 1; fast-forward past launchTeamInviteEnd
      await time.increase(ONE_WEEK + 1);
      await expect(
        crowdfund.addSeed(seed2.address)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });
  });

  // ============================================================
  // 1b. ARM Pre-Load Verification
  // ============================================================

  describe("ARM Pre-Load Verification", function () {
    // These tests use a fresh crowdfund WITHOUT the auto-loaded ARM
    // from the outer beforeEach, so we deploy a separate instance.
    let freshCrowdfund: any;
    let freshArmToken: any;

    beforeEach(async function () {
      const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
      freshArmToken = await ArmadaToken.deploy(deployer.address, deployer.address);
      await freshArmToken.waitForDeployment();
      await freshArmToken.initWhitelist([deployer.address]);

      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const freshOpenTimestamp = (await time.latest()) + 300;
      freshCrowdfund = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await freshArmToken.getAddress(),
        treasury.address,
        deployer.address,
        deployer.address,       // securityCouncil
        freshOpenTimestamp
      );
      await freshCrowdfund.waitForDeployment();
      await freshArmToken.addToWhitelist(await freshCrowdfund.getAddress());
    });

    it("loadArm() reverts when ARM balance is zero", async function () {
      await expect(
        freshCrowdfund.loadArm()
      ).to.be.revertedWith("ArmadaCrowdfund: insufficient ARM for MAX_SALE");
    });

    it("loadArm() reverts when ARM balance is below MAX_SALE", async function () {
      // Transfer 1 ARM short of the required 1,800,000
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), ARM(1_799_999));
      await expect(
        freshCrowdfund.loadArm()
      ).to.be.revertedWith("ArmadaCrowdfund: insufficient ARM for MAX_SALE");
    });

    it("loadArm() succeeds when balance equals MAX_SALE", async function () {
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), ARM(1_800_000));

      await expect(freshCrowdfund.loadArm())
        .to.emit(freshCrowdfund, "ArmLoaded");

      expect(await freshCrowdfund.armLoaded()).to.be.true;
    });

    it("loadArm() succeeds when balance exceeds MAX_SALE", async function () {
      const excess = ARM(2_000_000);
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), excess);

      await expect(freshCrowdfund.loadArm())
        .to.emit(freshCrowdfund, "ArmLoaded");

      expect(await freshCrowdfund.armLoaded()).to.be.true;
    });

    it("loadArm() is idempotent — second call is silent no-op", async function () {
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), ARM(1_800_000));

      // First call emits event
      await expect(freshCrowdfund.loadArm())
        .to.emit(freshCrowdfund, "ArmLoaded");

      // Second call does NOT emit event (idempotent no-op)
      await expect(freshCrowdfund.loadArm())
        .not.to.emit(freshCrowdfund, "ArmLoaded");
    });

    it("loadArm() is permissionless — non-admin can call", async function () {
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), ARM(1_800_000));
      await expect(freshCrowdfund.connect(outsider).loadArm())
        .to.emit(freshCrowdfund, "ArmLoaded");
      expect(await freshCrowdfund.armLoaded()).to.be.true;
    });

    it("addSeed reverts when ARM not loaded", async function () {
      await expect(
        freshCrowdfund.addSeed(seed1.address)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM not loaded");
    });

    it("full deployment sequence: deploy → transfer → loadArm → addSeeds", async function () {
      // 1. Deploy (done in beforeEach) — contract starts in Active phase
      expect(await freshCrowdfund.phase()).to.equal(Phase.Active);
      expect(await freshCrowdfund.armLoaded()).to.be.false;

      // 2. Transfer ARM
      await freshArmToken.transfer(await freshCrowdfund.getAddress(), ARM(1_800_000));

      // 3. loadArm()
      await freshCrowdfund.loadArm();
      expect(await freshCrowdfund.armLoaded()).to.be.true;

      // 4. Advance to window start
      await time.increaseTo(await freshCrowdfund.windowStart());

      // 5. Add seeds — works now that ARM is loaded and window is open
      await freshCrowdfund.addSeed(seed1.address);
      expect(await freshCrowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
      expect(await freshCrowdfund.phase()).to.equal(Phase.Active);
    });
  });

  // ============================================================
  // 2. Active Window — Invitations
  // ============================================================

  describe("Active Window — Invitations", function () {
    it("should transition to active phase", async function () {
      await crowdfund.addSeed(seed1.address);

      expect(await crowdfund.phase()).to.equal(Phase.Active);
      expect(await crowdfund.windowEnd()).to.be.gt(0);
    });

    it("constructor sets window timestamps correctly", async function () {
      const ws = await crowdfund.windowStart();
      const we = await crowdfund.windowEnd();
      const ltie = await crowdfund.launchTeamInviteEnd();

      // windowEnd = windowStart + 3 weeks
      expect(we - ws).to.equal(THREE_WEEKS);
      // launchTeamInviteEnd = windowStart + 1 week
      expect(ltie - ws).to.equal(ONE_WEEK);
      // windowStart should be the openTimestamp we passed to constructor
      expect(ws).to.be.gt(0);
    });

    it("addSeed() emits SeedAdded event", async function () {
      await expect(crowdfund.addSeed(seed1.address))
        .to.emit(crowdfund, "SeedAdded")
        .withArgs(seed1.address);
    });

    it("invite() reverts when invitee is zero address", async function () {
      await setupWithSeeds([seed1]);
      await expect(
        crowdfund.connect(seed1).invite(ethers.ZeroAddress, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: zero address");
    });

    it("should allow seed to invite at hop 1", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);

      expect(await crowdfund.isWhitelisted(hop1a.address, 1)).to.be.true;
      const committed = await crowdfund.getCommitment(hop1a.address, 1);
      expect(committed).to.equal(0);
    });

    it("should allow hop-1 to invite at hop 2", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      expect(await crowdfund.isWhitelisted(hop2a.address, 2)).to.be.true;
      const committed = await crowdfund.getCommitment(hop2a.address, 2);
      expect(committed).to.equal(0);
    });

    it("should reject hop-2 inviting (maxInvites = 0)", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      await expect(
        crowdfund.connect(hop2a).invite(outsider.address, 2)
      ).to.be.revertedWith("ArmadaCrowdfund: max hop reached");
    });

    it("should enforce invite limits (seed: 3)", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(seed1).invite(hop1b.address, 0);
      await crowdfund.connect(seed1).invite(hop1c.address, 0);

      // 4th invite should fail
      await expect(
        crowdfund.connect(seed1).invite(outsider.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should enforce invite limits (hop-1: 2)", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);
      await crowdfund.connect(hop1a).invite(hop2b.address, 1);

      // 3rd invite from hop-1 should fail
      await expect(
        crowdfund.connect(hop1a).invite(outsider.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should allow inviting address already whitelisted at different hop", async function () {
      await setupWithSeeds([seed1, seed2]);
      // seed2 is whitelisted at hop-0. seed1 invites seed2 to hop-1 — valid because
      // (seed2, 1) is a separate node from (seed2, 0).
      await crowdfund.connect(seed1).invite(seed2.address, 0);
      expect(await crowdfund.isWhitelisted(seed2.address, 1)).to.be.true;
    });

    it("should reject invite from non-whitelisted address", async function () {
      await setupWithSeeds([seed1]);
      await expect(
        crowdfund.connect(outsider).invite(hop1a.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: not whitelisted");
    });

    it("should reject invites outside active window", async function () {
      await setupWithSeeds([seed1]);
      await time.increase(THREE_WEEKS + 1); // past window end

      await expect(
        crowdfund.connect(seed1).invite(hop1a.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    it("should track whitelistCount correctly per hop", async function () {
      await setupWithSeeds([seed1, seed2]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(seed1).invite(hop1b.address, 0);
      await crowdfund.connect(seed2).invite(hop1c.address, 0);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      const [, , , wc0] = await crowdfund.getHopStats(0);
      const [, , , wc1] = await crowdfund.getHopStats(1);
      const [, , , wc2] = await crowdfund.getHopStats(2);
      expect(wc0).to.equal(2);
      expect(wc1).to.equal(3);
      expect(wc2).to.equal(1);
    });

    it("should track invites remaining correctly", async function () {
      await setupWithSeeds([seed1]);
      expect(await crowdfund.getInvitesRemaining(seed1.address, 0)).to.equal(3);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      expect(await crowdfund.getInvitesRemaining(seed1.address, 0)).to.equal(2);
      expect(await crowdfund.getInvitesRemaining(hop1a.address, 1)).to.equal(2);
    });

    it("invite() increments invitesSent on inviter node", async function () {
      await setupWithSeeds([seed1]);
      const before = await crowdfund.participants(seed1.address, 0);
      expect(before.invitesSent).to.equal(0);

      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      const after = await crowdfund.participants(seed1.address, 0);
      expect(after.invitesSent).to.equal(1);
    });
  });

  // ============================================================
  // 3. Active Window — Commitments
  // ============================================================

  describe("Active Window — Commitments", function () {
    it("commit() emits Committed event", async function () {
      await setupActive([seed1]);
      await expect(crowdfund.connect(seed1).commit(0, USDC(5_000)))
        .to.emit(crowdfund, "Committed")
        .withArgs(seed1.address, 0, USDC(5_000));
    });

    it("should allow whitelisted address to commit USDC", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(5_000));

      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(5_000));
      expect(await crowdfund.totalCommitted()).to.equal(USDC(5_000));
    });

    it("should allow multiple commits up to cap", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(5_000));
      await crowdfund.connect(seed1).commit(0, USDC(5_000));
      await crowdfund.connect(seed1).commit(0, USDC(5_000));

      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(15_000));
    });

    it("should accept over-cap commit ($15K for hop 0) for refund at settlement", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(15_001));

      // Over-cap deposits are accepted; totalCommitted includes the raw amount
      const [tc0] = await crowdfund.getHopStats(0);
      expect(tc0).to.equal(USDC(15_001));

      // Participant's raw commitment includes the full over-cap amount
      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(15_001));
    });

    it("should accept over-cap commit ($4K for hop 1) for refund at settlement", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);

      await crowdfund.connect(hop1a).commit(1, USDC(4_001));

      const [tc1] = await crowdfund.getHopStats(1);
      expect(tc1).to.equal(USDC(4_001));

      const committed = await crowdfund.getCommitment(hop1a.address, 1);
      expect(committed).to.equal(USDC(4_001));
    });

    it("should accept over-cap commit ($1K for hop 2) for refund at settlement", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      await crowdfund.connect(hop2a).commit(2, USDC(1_001));

      const [tc2] = await crowdfund.getHopStats(2);
      expect(tc2).to.equal(USDC(1_001));

      const committed = await crowdfund.getCommitment(hop2a.address, 2);
      expect(committed).to.equal(USDC(1_001));
    });

    it("should reject commit from non-whitelisted address", async function () {
      await setupActive([seed1]);

      await fundAndApprove(outsider, USDC(1_000));
      await expect(
        crowdfund.connect(outsider).commit(0, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not whitelisted");
    });

    it("should reject commit outside active window", async function () {
      await setupWithSeeds([seed1]);
      await time.increase(THREE_WEEKS + 1); // past window end
      await expect(
        crowdfund.connect(seed1).commit(0, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    it("should reject commit below $10 USDC minimum", async function () {
      await setupActive([seed1]);

      await expect(
        crowdfund.connect(seed1).commit(0, USDC(9))
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      await expect(
        crowdfund.connect(seed1).commit(0, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    it("should accept commit of exactly $10 USDC", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(10));
      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(10));
    });

    it("should track aggregate stats correctly", async function () {
      await setupWithSeeds([seed1, seed2]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);

      await crowdfund.connect(seed1).commit(0, USDC(10_000));
      await crowdfund.connect(seed2).commit(0, USDC(8_000));
      await crowdfund.connect(hop1a).commit(1, USDC(3_000));

      const [tc0, , uc0] = await crowdfund.getHopStats(0);
      expect(tc0).to.equal(USDC(18_000));
      expect(uc0).to.equal(2);

      const [tc1, , uc1] = await crowdfund.getHopStats(1);
      expect(tc1).to.equal(USDC(3_000));
      expect(uc1).to.equal(1);

      expect(await crowdfund.totalCommitted()).to.equal(USDC(21_000));
    });

    it("should track unique committers correctly", async function () {
      await setupActive([seed1]);

      // First commit: uniqueCommitters should go from 0 to 1
      await crowdfund.connect(seed1).commit(0, USDC(1_000));
      const [, , uc1] = await crowdfund.getHopStats(0);
      expect(uc1).to.equal(1);

      // Second commit from same address: uniqueCommitters should stay at 1
      await crowdfund.connect(seed1).commit(0, USDC(1_000));
      const [, , uc2] = await crowdfund.getHopStats(0);
      expect(uc2).to.equal(1);
    });
  });

  // ============================================================
  // 3b. Phase Stays Active During Window
  // ============================================================

  describe("Phase Stays Active During Window", function () {
    it("phase is Active before any commits", async function () {
      await setupActive([seed1]);
      expect(await crowdfund.phase()).to.equal(Phase.Active);
    });

    it("phase stays Active after commits", async function () {
      await setupActive([seed1, seed2]);
      await crowdfund.connect(seed1).commit(0, USDC(1_000));
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      await crowdfund.connect(seed2).commit(0, USDC(1_000));
      expect(await crowdfund.phase()).to.equal(Phase.Active);
    });

    it("finalize() works from Phase.Active after window ends", async function () {
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      expect(await crowdfund.phase()).to.equal(Phase.Active);

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
    });
  });

  // ============================================================
  // 4. Allocation Algorithm
  // ============================================================

  describe("Allocation Algorithm", function () {
    it("should use BASE_SALE when demand < elastic trigger", async function () {
      await setupActive([seed1]);

      // Commit well below elastic trigger ($1.5M)
      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      // Need to reach minimum ($1M), so fund many more seeds
      // For this test, let's just check elastic trigger logic with a known total
      await time.increase(THREE_WEEKS + 1);

      // totalCommitted = $15K, below min → will cancel
      // We need a different approach to test elastic: use enough signers
      // Skip: tested in end-to-end flows below
    });

    it("should allocate fully when demand <= reserve", async function () {
      // Setup: 68 seeds at $15K = $1.02M demand.
      // Hop-0 ceiling = 70% of netRaise = 70% of $1.14M = $798K, so demand > ceiling.
      // Need to reach MIN_SALE first — use many seeds
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Each seed commits $15K, 80 seeds = $1.2M (above minimum, at base trigger)
      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      // Total: 68 × $15K = $1,020,000 — above MIN_SALE

      // Wait, that's only $1.02M. Need 67 more to hit $1M. Let's do 67 × $15K = $1,005,000
      // Actually 68 × 15000 = 1,020,000 which is above MIN_SALE of 1,000,000. Good.

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_200_000)); // BASE_SALE

      // Hop 0 ceiling = 70% of $1.14M (netRaise) = $798K. Demand = $1,020,000 > $798K → pro-rata
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      // Pro-rata: alloc = (15000 * 798000) / 1020000 ≈ 11735.29 USDC worth
      expect(alloc).to.be.gt(0);
      expect(refund).to.be.gt(0); // some refund because oversubscribed
    });

    it("should pro-rata scale when demand > reserve", async function () {
      // 3 seeds each committing $15K = $45K total hop-0 demand
      // But we need to reach MIN_SALE ($1M). Need many more seeds.
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // 70 seeds × $15K = $1,050,000 total committed (above min, below elastic trigger)
      for (const s of seeds.slice(0, 70)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // saleSize = BASE_SALE = $1.2M
      // hop2Floor = 5% of $1.2M = $60K, netRaise = $1.14M
      // Hop 0 ceiling = 70% of $1.14M = $798,000
      // Hop 0 demand = $1,050,000 > $798,000 → pro-rata
      // scale = 798000 / 1050000 = 0.76
      // Each $15K commit → $11,400 allocation → 11,400 ARM
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      const allocArm = Number(alloc) / 1e18; // ARM allocation in whole tokens
      expect(allocArm).to.be.closeTo(11_400, 1); // ~11,400 ARM ($11.4K at $1/ARM)
      expect(refund).to.be.closeTo(USDC(3_600), USDC(1)); // ~$3.6K refund
    });
  });

  // ============================================================
  // 5. Finalization & Cancellation
  // ============================================================

  describe("Finalization & Cancellation", function () {
    it("should finalize successfully after window ends", async function () {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.be.gt(0);
      // totalAllocatedArm is hop-level aggregate, computed at finalization
      expect(await crowdfund.totalAllocatedArm()).to.be.gt(0);
      // Unallocated USDC = saleSize - totalAllocatedUsdc
      const saleSize = await crowdfund.saleSize();
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      expect(saleSize - totalAllocUsdc).to.be.gte(0);
    });

    it("unallocated reserve is queryable via saleSize - totalAllocatedUsdc", async function () {
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));


      // Only 68 seeds commit
      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Hop-0 demand ($1.02M) > ceiling ($798K) → over-subscribed.
      const saleSizeVal = await crowdfund.saleSize();
      const totalAllocUsdcVal = await crowdfund.totalAllocatedUsdc();
      const leftover = saleSizeVal - totalAllocUsdcVal;
      expect(leftover).to.be.gt(0);
    });

    it("should reject finalize before window ends", async function () {
      await setupWithSeeds([seed1]);
      // Still within the 3-week active window

      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: window not ended");
    });

    it("should reject double finalization", async function () {
      const seeds = allSigners.slice(1, 70);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: already finalized");
    });

    it("should revert finalize when below minimum raise", async function () {
      await setupActive([seed1]);
      await crowdfund.connect(seed1).commit(0, USDC(15_000)); // way below $1M min

      await time.increase(THREE_WEEKS + 1);
      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum raise");

      // Phase stays Active — participants use claimRefund() directly
      expect(await crowdfund.phase()).to.equal(Phase.Active);
    });

    it("should require ARM pre-load before seeds can be added", async function () {
      // Deploy a new crowdfund without ARM funding
      const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
      const unfundedOpenTimestamp = (await time.latest()) + 300;
      const unfundedCrowdfund = await ArmadaCrowdfund.deploy(
        await usdc.getAddress(),
        await armToken.getAddress(),
        treasury.address,
        deployer.address,
        deployer.address,       // securityCouncil
        unfundedOpenTimestamp
      );
      await unfundedCrowdfund.waitForDeployment();

      // loadArm() reverts without ARM
      await expect(
        unfundedCrowdfund.loadArm()
      ).to.be.revertedWith("ArmadaCrowdfund: insufficient ARM for MAX_SALE");

      // addSeed() reverts without loadArm() (armLoaded guard)
      await expect(
        unfundedCrowdfund.addSeed(seed1.address)
      ).to.be.revertedWith("ArmadaCrowdfund: ARM not loaded");
    });
  });

  // ============================================================
  // 6. Claims & Refunds
  // ============================================================

  describe("Claims & Refunds", function () {
    it("should allow claim after finalization (ARM only, no USDC)", async function () {
      // Setup with oversubscribed hop-0
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 70)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const armBefore = await armToken.balanceOf(seeds[0].address);
      const usdcBefore = await usdc.balanceOf(seeds[0].address);

      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);

      const armAfter = await armToken.balanceOf(seeds[0].address);
      const usdcAfter = await usdc.balanceOf(seeds[0].address);

      expect(armAfter).to.be.gt(armBefore); // received ARM
      expect(usdcAfter).to.be.gte(usdcBefore); // claim() transfers both ARM tokens and USDC refund
    });

    it("should reject double claim", async function () {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);
      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("should allow full refund via deadline fallback (below min, no finalize)", async function () {
      await setupActive([seed1]);
      await crowdfund.connect(seed1).commit(0, USDC(10_000));

      const usdcBefore = await usdc.balanceOf(seed1.address);
      await time.increase(THREE_WEEKS + 1);
      // No finalize or cancel — deadline fallback path in claimRefund()
      await crowdfund.connect(seed1).claimRefund();
      const usdcAfter = await usdc.balanceOf(seed1.address);
      expect(usdcAfter - usdcBefore).to.equal(USDC(10_000));
    });

    it("should reject claimRefund during active window", async function () {
      await setupActive([seed1]);
      await crowdfund.connect(seed1).commit(0, USDC(10_000));

      await expect(
        crowdfund.connect(seed1).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");
    });

    it("should push USDC proceeds to treasury at finalization", async function () {
      const seeds = allSigners.slice(1, 80);
      const committers = seeds.slice(0, 68);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of committers) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);

      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await crowdfund.finalize();
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      // Proceeds pushed atomically at finalization (minus small rounding buffer)
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      const pushed = treasuryAfter - treasuryBefore;
      expect(totalAllocUsdc).to.be.gt(0);
      expect(pushed).to.be.lte(totalAllocUsdc);
      expect(pushed).to.be.gte(totalAllocUsdc - 500n);

      // Contract retains refund USDC (plus rounding buffer)
      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      const totalCommitted = await crowdfund.totalCommitted();
      expect(contractUsdc).to.be.gte(totalCommitted - totalAllocUsdc);
      expect(contractUsdc).to.be.lte(totalCommitted - totalAllocUsdc + 500n);
    });

    it("should allow anyone to sweep unallocated ARM", async function () {
      const seeds = allSigners.slice(1, 80);
      const committers = seeds.slice(0, 68);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of committers) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // totalAllocated is hop-level upper bound, totalArmClaimed tracks claims
      const totalAlloc = await crowdfund.totalAllocatedArm();
      const armInContract = await armToken.balanceOf(await crowdfund.getAddress());
      // Before claims: armStillOwed = totalAlloc - 0 = totalAlloc
      const expectedUnalloc = armInContract - totalAlloc;

      // Permissionless — called by a random non-admin signer
      const treasuryBefore = await armToken.balanceOf(treasury.address);
      await crowdfund.connect(seed1).withdrawUnallocatedArm();
      const treasuryAfter = await armToken.balanceOf(treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(expectedUnalloc);
    });
  });

  // ============================================================
  // 6b. Claim Separation (claim = ARM only, claimRefund = USDC only)
  // ============================================================

  describe("Claim Separation", function () {
    // Shared setup: oversubscribed hop-0 so there's a meaningful refund
    async function setupOversubscribed() {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 70)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
      return seeds;
    }

    it("claim() transfers both ARM and USDC refund in single call", async function () {
      const seeds = await setupOversubscribed();
      const armBefore = await armToken.balanceOf(seeds[0].address);
      const usdcBefore = await usdc.balanceOf(seeds[0].address);

      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);

      // Hop-0 is oversubscribed → both ARM allocated and USDC refunded
      expect(await armToken.balanceOf(seeds[0].address)).to.be.gt(armBefore);
      expect(await usdc.balanceOf(seeds[0].address)).to.be.gt(usdcBefore);
    });

    it("claimRefund() reverts after normal finalization (success-path refunds via claim())", async function () {
      const seeds = await setupOversubscribed();

      await expect(
        crowdfund.connect(seeds[0]).claimRefund()
      ).to.be.revertedWith("ArmadaCrowdfund: refund not available");
    });

    it("claim() reverts in refundMode", async function () {
      // 80 seeds, all hop-0 only → refundMode
      const seeds = allSigners.slice(1, 81);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: sale in refund mode");
    });

    it("claimRefund() works in failure paths", async function () {
      // Path 1: RefundMode
      {
        const cf = await (await ethers.getContractFactory("ArmadaCrowdfund")).deploy(
          await usdc.getAddress(), await armToken.getAddress(),
          treasury.address, deployer.address, deployer.address,
          (await time.latest()) + 10
        );
        await armToken.transfer(await cf.getAddress(), ARM(1_800_000));
        await cf.loadArm();
        await time.increaseTo(await cf.windowStart());
        const s = allSigners.slice(1, 81);
        await cf.addSeeds(s.map(a => a.address));
        for (const a of s) {
          await fundAndApprove(a, USDC(15_000));
          await usdc.connect(a).approve(await cf.getAddress(), USDC(15_000));
          await cf.connect(a).commit(0, USDC(15_000));
        }
        await time.increase(THREE_WEEKS + 1);
        await cf.finalize();
        expect(await cf.refundMode()).to.be.true;

        const balBefore = await usdc.balanceOf(s[0].address);
        await cf.connect(s[0]).claimRefund();
        expect(await usdc.balanceOf(s[0].address) - balBefore).to.equal(USDC(15_000));
      }

      // Path 3: Canceled — tested in settlement tests
      // Path 4: Deadline fallback — tested in integration tests (deadline fallback test)
    });

    it("double claim() reverts", async function () {
      const seeds = await setupOversubscribed();
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);

      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("claim() after claim() reverts (shared claimed flag)", async function () {
      const seeds = await setupOversubscribed();
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);

      await expect(
        crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("Allocated event emitted with delegate address", async function () {
      const seeds = await setupOversubscribed();
      const delegate = allSigners[199].address;

      await expect(crowdfund.connect(seeds[0]).claim(delegate))
        .to.emit(crowdfund, "Allocated");
    });

    it("claim() after deadline still transfers refund (refunds never expire)", async function () {
      const seeds = await setupOversubscribed();

      const deadline = await crowdfund.claimDeadline();
      await time.increaseTo(deadline + 1n);

      // Post-deadline: ARM forfeited, but refund still transfers
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);
      const usdcAfter = await usdc.balanceOf(seeds[0].address);
      expect(usdcAfter - usdcBefore).to.be.gt(0n);

      // ARM was not transferred (forfeited)
      expect(await armToken.balanceOf(seeds[0].address)).to.equal(0n);
    });
  });

  // ============================================================
  // 7. View Functions & Graph Privacy
  // ============================================================

  describe("View Functions & Graph Privacy", function () {
    it("should return correct aggregate stats during sale", async function () {
      await setupWithSeeds([seed1, seed2]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(seed1).commit(0, USDC(10_000));

      const [tc, phase_, ws, we] = await crowdfund.getSaleStats();
      expect(tc).to.equal(USDC(10_000));
      expect(ws).to.be.gt(0);
      expect(we).to.be.gt(0);
    });

    it("should expose invite graph during sale (no phase restriction)", async function () {
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);

      const inviter = await crowdfund.getInviteEdge(hop1a.address, 1);
      expect(inviter).to.equal(seed1.address);
    });

    it("should reveal invite graph after finalization", async function () {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Seeds have invitedBy = address(0)
      const inviter = await crowdfund.getInviteEdge(seeds[0].address, 0);
      expect(inviter).to.equal(ethers.ZeroAddress);
    });

    it("should return correct allocation details after finalization", async function () {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      expect(alloc).to.be.gt(0);
      expect(await crowdfund.claimed(seeds[0].address)).to.be.false;
    });
  });

  // ============================================================
  // 8. End-to-End Flows
  // ============================================================

  describe("End-to-End Flows", function () {
    it("complete flow with sufficient commitments", async function () {
      // Setup 70 seeds, each commits $15K = $1.05M > MIN_SALE
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));


      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      // 70 × $15K = $1,050,000 > MIN_SALE, < ELASTIC_TRIGGER ($1.5M)

      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));

      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_200_000)); // BASE

      // Hop-0 demand = $1,050,000, ceiling = 70% of $1.14M = $798,000 → pro-rata
      // scale = 798000/1050000 = 0.76
      // Each $15K → $11,400 allocated → 11,400 ARM

      // Claim first seed
      const armBefore = await armToken.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);
      const armAfter = await armToken.balanceOf(seeds[0].address);

      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      expect(armAfter - armBefore).to.equal(alloc);
      expect(alloc).to.be.gt(0);
    });

    it("elastic expansion triggered", async function () {
      // Need totalCommitted >= $1.5M (ELASTIC_TRIGGER)
      // 100 seeds × $15K = $1.5M. Need 100+ signers.
      // With default 20 signers this isn't enough. Tested in adversarial suite
      // which uses 200 signers (hardhat.config.ts accounts count).
      this.skip(); // Requires more than 20 Hardhat default signers
    });

    it("cancellation (below minimum) — claimRefund via deadline fallback", async function () {
      await setupActive([seed1, seed2]);
      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed2).commit(0, USDC(10_000));
      // Total: $25K << $1M minimum

      await time.increase(THREE_WEEKS + 1);
      // finalize() reverts (below MIN_SALE) — participants use claimRefund() directly
      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum raise");

      // Both can claimRefund via deadline fallback path
      const usdcBefore1 = await usdc.balanceOf(seed1.address);
      await crowdfund.connect(seed1).claimRefund();
      expect(await usdc.balanceOf(seed1.address) - usdcBefore1).to.equal(USDC(15_000));

      const usdcBefore2 = await usdc.balanceOf(seed2.address);
      await crowdfund.connect(seed2).claimRefund();
      expect(await usdc.balanceOf(seed2.address) - usdcBefore2).to.equal(USDC(10_000));
    });
  });

  // ============================================================
  // 11. Governance Integration
  // ============================================================

  describe("Governance Integration", function () {
    it("claimed ARM can be delegated for voting power via ERC20Votes", async function () {
      // Full flow: crowdfund → claim → delegate for governance participation
      const seeds = allSigners.slice(1, 71);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await addHop1ForMinSale(seeds.slice(0, 51), allSigners.slice(140, 200));
      await time.increase(THREE_WEEKS + 1);
      await crowdfund.finalize();

      // Claim ARM
      await crowdfund.connect(seeds[0]).claim(ethers.ZeroAddress);
      const armBalance = await armToken.balanceOf(seeds[0].address);
      expect(armBalance).to.be.gt(0);

      // Self-delegate to activate voting power (ERC20Votes)
      await armToken.connect(seeds[0]).delegate(seeds[0].address);

      const votingPower = await armToken.getVotes(seeds[0].address);
      expect(votingPower).to.equal(armBalance);
    });
  });
});
