/**
 * Crowdfund Integration Tests
 *
 * Tests the full Armada crowdfund system:
 * - Setup: seed management, phase transitions
 * - Active window: invites, commits, cap enforcement
 * - Allocation: elastic expansion, pro-rata, rollover, cancellation
 * - Settlement: launch-team payment, treasury proceeds, rounding buffer
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
const WINDOW = 5 * ONE_DAY; // commitment window; the launch-team window spans it too

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

  // The launch team places hop-1 team inviter wallets (the only tier that can invite).
  async function placeTeamWallets(wallets: SignerWithAddress[]) {
    for (const w of wallets) await crowdfund.launchTeamInvite(w.address, 0);
  }

  async function warpPastWindow() {
    await time.increaseTo((await crowdfund.windowEnd()) + 1n);
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
      await fundAndApprove(signer, USDC(200_000));
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
      expect(we - ws).to.equal(WINDOW);
      expect(ltie - ws).to.equal(WINDOW);

      // Check hop configs. ceilingBps is unused by the allocation (hop-2 reserve first, then
      // hop-0, hop-1, hop-2 extra) and stays 0 on every hop.
      // Tuple order matches struct field order after audit-68 packing reorder:
      // (ceilingBps, maxInvites, maxInvitesReceived, capUsdc).
      const [ceilingBps0, maxInv0, maxRecv0, cap0] = await crowdfund.hopConfigs(0);
      expect(ceilingBps0).to.equal(0);
      expect(cap0).to.equal(USDC(100_000));
      expect(maxInv0).to.equal(0);
      expect(maxRecv0).to.equal(1);

      const [ceilingBps1, maxInv1, maxRecv1, cap1] = await crowdfund.hopConfigs(1);
      expect(ceilingBps1).to.equal(0);
      expect(cap1).to.equal(0);
      expect(maxInv1).to.equal(100);
      expect(maxRecv1).to.equal(1);

      const [ceilingBps2, maxInv2, maxRecv2, cap2] = await crowdfund.hopConfigs(2);
      expect(ceilingBps2).to.equal(0);
      expect(cap2).to.equal(USDC(10_000));
      expect(maxInv2).to.equal(0);
      expect(maxRecv2).to.equal(20); // hop-2 stacks up to 20 invites ($10K of cap each)
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

    it("should reject adding seeds after the launch-team invite window", async function () {
      await crowdfund.addSeed(seed1.address);

      // Seeds are allowed during the launch-team invite window.
      await time.increaseTo((await crowdfund.launchTeamInviteEnd()) + 1n);
      await expect(
        crowdfund.addSeed(seed2.address)
      ).to.be.revertedWith("ArmadaCrowdfund: outside week-1 window");
    });

    // WHY: The launch-team window spans the full commitment window, so hop-0 additions
    // must still succeed on the final day of the 5-day window.
    it("should allow adding seeds on the final day of the window (4 days in)", async function () {
      await time.increase(4 * ONE_DAY);
      await crowdfund.addSeed(seed1.address);
      expect(await crowdfund.isWhitelisted(seed1.address, 0)).to.be.true;
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

      // windowEnd = windowStart + 5 days
      expect(we - ws).to.equal(WINDOW);
      // launchTeamInviteEnd = windowStart + 5 days (spans the full commitment window)
      expect(ltie - ws).to.equal(WINDOW);
      expect(ltie).to.equal(we);
      // windowStart should be the openTimestamp we passed to constructor
      expect(ws).to.be.gt(0);
    });

    it("addSeed() emits SeedAdded event", async function () {
      await expect(crowdfund.addSeed(seed1.address))
        .to.emit(crowdfund, "SeedAdded")
        .withArgs(seed1.address);
    });

    it("invite() reverts when invitee is zero address", async function () {
      await placeTeamWallets([hop1a]);
      await expect(
        crowdfund.connect(hop1a).invite(ethers.ZeroAddress, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: zero address");
    });

    // WHY: known contributors cannot invite (HOP0_MAX_INVITES = 0).
    it("should not allow a seed to invite at hop 1", async function () {
      await setupWithSeeds([seed1]);
      await expect(
        crowdfund.connect(seed1).invite(hop1a.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");

      expect(await crowdfund.isWhitelisted(hop1a.address, 1)).to.be.false;
    });

    it("should allow hop-1 (team wallet) to invite at hop 2", async function () {
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      expect(await crowdfund.isWhitelisted(hop2a.address, 2)).to.be.true;
      const committed = await crowdfund.getCommitment(hop2a.address, 2);
      expect(committed).to.equal(0);
    });

    it("should reject hop-2 inviting (maxInvites = 0)", async function () {
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      await expect(
        crowdfund.connect(hop2a).invite(outsider.address, 2)
      ).to.be.revertedWith("ArmadaCrowdfund: max hop reached");
    });

    it("should enforce invite limits (seed: 0)", async function () {
      await setupWithSeeds([seed1]);

      // A seed's first invite already fails
      await expect(
        crowdfund.connect(seed1).invite(outsider.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should enforce invite limits (hop-1: 100)", async function () {
      await placeTeamWallets([hop1a]);
      for (let i = 0; i < 100; i++) {
        await crowdfund.connect(hop1a).invite(allSigners[50 + i].address, 1);
      }

      // 101st invite from hop-1 should fail
      await expect(
        crowdfund.connect(hop1a).invite(outsider.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should allow inviting address already whitelisted at different hop", async function () {
      await setupWithSeeds([seed2]);
      await placeTeamWallets([hop1a]);
      // seed2 is whitelisted at hop-0. The team wallet invites seed2 to hop-2 — valid because
      // (seed2, 2) is a separate node from (seed2, 0).
      await crowdfund.connect(hop1a).invite(seed2.address, 1);
      expect(await crowdfund.isWhitelisted(seed2.address, 2)).to.be.true;
    });

    it("should reject invite from non-whitelisted address", async function () {
      await setupWithSeeds([seed1]);
      await expect(
        crowdfund.connect(outsider).invite(hop1a.address, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: not whitelisted");
    });

    it("should reject invites outside active window", async function () {
      await placeTeamWallets([hop1a]);
      await warpPastWindow(); // past window end

      await expect(
        crowdfund.connect(hop1a).invite(hop2a.address, 1)
      ).to.be.revertedWith("ArmadaCrowdfund: window closed");
    });

    // WHY: whitelistCount counts nodes, not invites. Each hop is populated by its own path
    //      (seeds, the single launch-team hop-1 team wallet, team-wallet and launch-team hop-2
    //      invites), and a stacked hop-2 invite adds cap to an existing node without adding one.
    it("should track whitelistCount correctly per hop", async function () {
      await setupWithSeeds([seed1, seed2]);
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);
      await crowdfund.launchTeamInvite(hop2b.address, 1);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1); // stacks on hop2a's node

      const [, , , wc0] = await crowdfund.getHopStats(0);
      const [, , , wc1] = await crowdfund.getHopStats(1);
      const [, , , wc2] = await crowdfund.getHopStats(2);
      expect(wc0).to.equal(2);
      expect(wc1).to.equal(1);
      expect(wc2).to.equal(2);
      expect(await crowdfund.getInvitesReceived(hop2a.address, 2)).to.equal(2);
    });

    it("should track invites remaining correctly", async function () {
      await setupWithSeeds([seed1]);
      await placeTeamWallets([hop1a]);
      expect(await crowdfund.getInvitesRemaining(seed1.address, 0)).to.equal(0);
      expect(await crowdfund.getInvitesRemaining(hop1a.address, 1)).to.equal(100);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);
      expect(await crowdfund.getInvitesRemaining(hop1a.address, 1)).to.equal(99);
      expect(await crowdfund.getInvitesRemaining(hop2a.address, 2)).to.equal(0);
    });

    it("invite() increments invitesSent on inviter node", async function () {
      await placeTeamWallets([hop1a]);
      const before = await crowdfund.participants(hop1a.address, 1);
      expect(before.invitesSent).to.equal(0);

      await crowdfund.connect(hop1a).invite(hop2a.address, 1);
      const after = await crowdfund.participants(hop1a.address, 1);
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

    // WHY: commits accumulate on the node; two commits reaching exactly the $100K hop-0 cap
    //      must sum, not overwrite.
    it("should allow multiple commits up to cap", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(50_000));
      await crowdfund.connect(seed1).commit(0, USDC(50_000));

      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(100_000));
      expect(await crowdfund.getEffectiveCap(seed1.address, 0)).to.equal(USDC(100_000));
    });

    // WHY: commit() does not enforce the cap; one unit over the $100K hop-0 cap is escrowed raw
    //      and the excess is refunded at settlement.
    it("should accept over-cap commit ($100K for hop 0) for refund at settlement", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(100_001));

      // Over-cap deposits are accepted; totalCommitted includes the raw amount
      const [tc0] = await crowdfund.getHopStats(0);
      expect(tc0).to.equal(USDC(100_001));

      // Participant's raw commitment includes the full over-cap amount
      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(100_001));
    });

    // WHY: hop-1 team wallets have a $0 cap, so any commit there is over-cap: accepted raw and
    //      refunded in full at settlement.
    it("should accept over-cap commit at hop 1 (team wallet, $0 cap) for refund at settlement", async function () {
      await placeTeamWallets([hop1a]);

      await crowdfund.connect(hop1a).commit(1, USDC(100));

      const [tc1] = await crowdfund.getHopStats(1);
      expect(tc1).to.equal(USDC(100));

      const committed = await crowdfund.getCommitment(hop1a.address, 1);
      expect(committed).to.equal(USDC(100));
      expect(await crowdfund.getEffectiveCap(hop1a.address, 1)).to.equal(0);
    });

    it("should accept over-cap commit ($10K for hop 2) for refund at settlement", async function () {
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      await crowdfund.connect(hop2a).commit(2, USDC(10_001));

      const [tc2] = await crowdfund.getHopStats(2);
      expect(tc2).to.equal(USDC(10_001));

      const committed = await crowdfund.getCommitment(hop2a.address, 2);
      expect(committed).to.equal(USDC(10_001));
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
      await warpPastWindow(); // past window end
      await expect(
        crowdfund.connect(seed1).commit(0, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    // WHY: MIN_COMMIT ($100) keeps dust commits from bloating finalize/claim work; one unit
    //      below it and zero must both revert.
    it("should reject commit below $100 USDC minimum", async function () {
      await setupActive([seed1]);

      await expect(
        crowdfund.connect(seed1).commit(0, USDC(100) - 1n)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");

      await expect(
        crowdfund.connect(seed1).commit(0, 0)
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    // WHY: the minimum is inclusive; exactly MIN_COMMIT ($100) must be accepted.
    it("should accept commit of exactly $100 USDC", async function () {
      await setupActive([seed1]);

      await crowdfund.connect(seed1).commit(0, USDC(100));
      const committed = await crowdfund.getCommitment(seed1.address, 0);
      expect(committed).to.equal(USDC(100));
    });

    it("should track aggregate stats correctly", async function () {
      await setupWithSeeds([seed1, seed2]);
      await placeTeamWallets([hop1a]); // its hop-1 commit is over its $0 cap but counted raw

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

      await warpPastWindow();
      await crowdfund.finalize();
      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
    });
  });

  // ============================================================
  // 4. Allocation Algorithm
  // ============================================================

  describe("Allocation Algorithm", function () {
    // WHY: a successful sale below the $1.8M trigger settles at BASE_SALE. Three known
    //      contributors at the $100K hop-0 cap ($300K) clear MIN_SALE ($250K) without reaching
    //      the trigger.
    it("should use BASE_SALE when demand < elastic trigger", async function () {
      await setupActive([seed1, seed2, seed3]);

      await crowdfund.connect(seed1).commit(0, USDC(100_000));
      await crowdfund.connect(seed2).commit(0, USDC(100_000));
      await crowdfund.connect(seed3).commit(0, USDC(100_000));
      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.refundMode()).to.be.false;
      expect(await crowdfund.saleSize()).to.equal(await crowdfund.BASE_SALE());
    });

    // WHY: an under-subscribed sale must fill every capped commit in full. With no hop-2 demand,
    //      the unused $300K hop-2 reserve rolls to hop-0, so hop-0 can take the whole sale.
    it("should allocate fully when demand <= sale size", async function () {
      // 68 seeds at $15K = $1.02M demand, under the $1.8M sale.
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 68)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_800_000)); // BASE_SALE

      // Under-subscribed → full allocation, no refund.
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      expect(alloc).to.equal(ARM(15_000));
      expect(refund).to.equal(0n);
    });

    // WHY: when hop-0 capped demand exceeds the sale, every hop-0 commit is scaled by the same
    //      ratio (sale / demand) and the excess is refunded. With no hop-2 demand, hop-0's
    //      allocation is the whole $1.8M sale.
    it("should pro-rata scale when demand > sale size", async function () {
      // 76 seeds × $25K = $1.9M hop-0 demand against the $1.8M sale.
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 76)) {
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      // Each $25K commit receives floor($25K × $1.8M / $1.9M) ≈ $23,684.21.
      expect(await crowdfund.finalCeilings(0)).to.equal(USDC(1_800_000));
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      const accepted = (USDC(25_000) * USDC(1_800_000)) / USDC(1_900_000);
      expect(alloc).to.equal(accepted * 10n ** 12n);
      expect(refund).to.equal(USDC(25_000) - accepted);
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


      await warpPastWindow();
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


      await warpPastWindow();
      await crowdfund.finalize();

      // Hop-0 demand ($1.02M) is below the $1.8M sale, leaving $780K unallocated.
      const saleSizeVal = await crowdfund.saleSize();
      const totalAllocUsdcVal = await crowdfund.totalAllocatedUsdc();
      const leftover = saleSizeVal - totalAllocUsdcVal;
      expect(leftover).to.equal(USDC(780_000));
    });

    it("should reject finalize before window ends", async function () {
      await setupWithSeeds([seed1]);
      // Still within the 5-day active window

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
      await warpPastWindow();
      await crowdfund.finalize();

      await expect(
        crowdfund.finalize()
      ).to.be.revertedWith("ArmadaCrowdfund: already finalized");
    });

    // WHY: Below-minimum demand causes finalize() to enter refundMode (not revert).
    // The phase must transition to Finalized so ARM is recoverable via withdrawUnallocatedArm().
    // A failed sale pays nobody: the launch team gets no team payment and the treasury no
    // proceeds; every committed dollar stays in the contract for claimRefund().
    it("should enter refundMode when finalized below minimum raise", async function () {
      await setupActive([seed1]);
      await crowdfund.connect(seed1).commit(0, USDC(15_000)); // way below $250K min

      await warpPastWindow();
      const teamBefore = await usdc.balanceOf(deployer.address); // deployer is launchTeam
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await expect(crowdfund.finalize()).not.to.emit(crowdfund, "LaunchTeamPaid");

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.refundMode()).to.be.true;
      expect(await usdc.balanceOf(deployer.address)).to.equal(teamBefore);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await usdc.balanceOf(await crowdfund.getAddress())).to.equal(USDC(15_000));
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
      // 70 × $15K = $1.05M: under the sale, so the claim is ARM with no refund
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 70)) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await warpPastWindow();
      await crowdfund.finalize();

      const armBefore = await armToken.balanceOf(seeds[0].address);
      const usdcBefore = await usdc.balanceOf(seeds[0].address);

      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

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
      await warpPastWindow();
      await crowdfund.finalize();

      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    // WHY: When demand is below MIN_SALE, finalize() enters refundMode. Participants
    // then claim full USDC refunds via claimRefund().
    it("should allow full refund after below-minimum finalize", async function () {
      await setupActive([seed1]);
      await crowdfund.connect(seed1).commit(0, USDC(10_000));

      await warpPastWindow();
      // finalize enters refundMode (below MIN_SALE)
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      const usdcBefore = await usdc.balanceOf(seed1.address);
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

    // WHY: on success, finalize() pays TEAM_PAYMENT_USDC ($250K) to the launch team and pushes
    //      the rest of the net proceeds to the treasury atomically. No hop is pro-rated here
    //      ($1.02M < $1.8M), so no rounding buffer is held and the split is exact: the contract
    //      keeps only what claims will refund.
    it("should pay the launch team and push the remaining USDC proceeds to treasury at finalization", async function () {
      const seeds = allSigners.slice(1, 80);
      const committers = seeds.slice(0, 68);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of committers) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await warpPastWindow();

      const teamPayment = await crowdfund.TEAM_PAYMENT_USDC();
      expect(teamPayment).to.equal(USDC(250_000));
      const teamBefore = await usdc.balanceOf(deployer.address); // deployer is launchTeam
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await expect(crowdfund.finalize())
        .to.emit(crowdfund, "LaunchTeamPaid")
        .withArgs(deployer.address, teamPayment);
      const treasuryAfter = await usdc.balanceOf(treasury.address);

      // Launch team receives exactly the team payment; treasury receives the rest
      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      expect(totalAllocUsdc).to.equal(USDC(1_020_000));
      expect(await usdc.balanceOf(deployer.address) - teamBefore).to.equal(teamPayment);
      expect(treasuryAfter - treasuryBefore).to.equal(totalAllocUsdc - teamPayment);

      // Contract retains exactly the refund USDC (no buffer without pro-rating)
      const contractUsdc = await usdc.balanceOf(await crowdfund.getAddress());
      const totalCommitted = await crowdfund.totalCommitted();
      expect(contractUsdc).to.equal(totalCommitted - totalAllocUsdc);
    });

    // WHY: when a hop is pro-rated, lazy per-participant floor divisions can sum to slightly
    //      less than totalAllocatedUsdc, so finalize() holds back one USDC unit per participant
    //      node as a rounding buffer before paying out. The team payment is still exactly $250K
    //      and the treasury gets totalAllocatedUsdc - buffer - $250K.
    it("should hold a rounding buffer and still pay the launch team $250K when a hop is pro-rated", async function () {
      // 76 seeds × $25K = $1.9M hop-0 demand against the $1.8M sale; 79 seed nodes registered
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds.slice(0, 76)) {
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }
      await warpPastWindow();

      const teamPayment = await crowdfund.TEAM_PAYMENT_USDC();
      const teamBefore = await usdc.balanceOf(deployer.address); // deployer is launchTeam
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      await crowdfund.finalize();

      const totalAllocUsdc = await crowdfund.totalAllocatedUsdc();
      const buffer = await crowdfund.getParticipantCount();
      expect(totalAllocUsdc).to.equal(USDC(1_800_000));
      expect(buffer).to.equal(79n);
      expect(await usdc.balanceOf(deployer.address) - teamBefore).to.equal(teamPayment);
      expect(await usdc.balanceOf(treasury.address) - treasuryBefore)
        .to.equal(totalAllocUsdc - buffer - teamPayment);

      // Contract retains the aggregate refund plus the buffer
      const totalCommitted = await crowdfund.totalCommitted();
      expect(await usdc.balanceOf(await crowdfund.getAddress()))
        .to.equal(totalCommitted - totalAllocUsdc + buffer);
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
      await warpPastWindow();
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
    // Shared setup: oversubscribed hop-0 (76 × $25K = $1.9M > $1.8M) so there's a meaningful refund
    async function setupOversubscribed() {
      const seeds = allSigners.slice(1, 80);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(25_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds.slice(0, 76)) {
        await crowdfund.connect(s).commit(0, USDC(25_000));
      }
      await warpPastWindow();
      await crowdfund.finalize();
      return seeds;
    }

    it("claim() transfers both ARM and USDC refund in single call", async function () {
      const seeds = await setupOversubscribed();
      const armBefore = await armToken.balanceOf(seeds[0].address);
      const usdcBefore = await usdc.balanceOf(seeds[0].address);

      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

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
      // 16 seeds × $15K = $240K < MIN_SALE → refundMode
      const seeds = allSigners.slice(1, 17);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(15_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));

      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(15_000));
      }
      await warpPastWindow();
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
        const s = allSigners.slice(1, 17); // 16 × $15K = $240K < MIN_SALE
        await cf.addSeeds(s.map(a => a.address));
        for (const a of s) {
          await fundAndApprove(a, USDC(15_000));
          await usdc.connect(a).approve(await cf.getAddress(), USDC(15_000));
          await cf.connect(a).commit(0, USDC(15_000));
        }
        await time.increaseTo((await cf.windowEnd()) + 1n);
        await cf.finalize();
        expect(await cf.refundMode()).to.be.true;

        const balBefore = await usdc.balanceOf(s[0].address);
        await cf.connect(s[0]).claimRefund();
        expect(await usdc.balanceOf(s[0].address) - balBefore).to.equal(USDC(15_000));
      }

      // Path 3: Canceled — tested in settlement tests
    });

    it("double claim() reverts", async function () {
      const seeds = await setupOversubscribed();
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("claim() after claim() reverts (shared claimed flag)", async function () {
      const seeds = await setupOversubscribed();
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);

      await expect(
        crowdfund.connect(seeds[0]).claim(seeds[0].address)
      ).to.be.revertedWith("ArmadaCrowdfund: already claimed");
    });

    it("Allocated event emitted with delegate address", async function () {
      const seeds = await setupOversubscribed();
      const delegate = allSigners[199].address;

      const [expectedArm, expectedRefund] = await crowdfund.computeAllocation(seeds[0].address);
      await expect(crowdfund.connect(seeds[0]).claim(delegate))
        .to.emit(crowdfund, "Allocated")
        .withArgs(seeds[0].address, expectedArm, expectedRefund, delegate);
    });

    it("AllocatedHop only emitted for hops with non-zero allocation", async function () {
      const seeds = await setupOversubscribed();

      // seeds[0] committed only on hop 0 — should emit exactly one AllocatedHop
      const tx = await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const receipt = await tx.wait();

      // Parse AllocatedHop events from the claim receipt
      const hopEvents = receipt.logs
        .map((l: any) => { try { return crowdfund.interface.parseLog(l); } catch { return null; } })
        .filter((e: any) => e?.name === "AllocatedHop");

      // Participant committed on hop-0 only, so exactly one AllocatedHop expected
      expect(hopEvents.length).to.equal(1);
      expect(hopEvents[0].args.participant).to.equal(seeds[0].address);
      expect(hopEvents[0].args.hop).to.equal(0);
      expect(hopEvents[0].args.acceptedUsdc).to.be.gt(0n);
    });

    it("Allocated event emits delegate=address(0) on post-deadline claim", async function () {
      const seeds = await setupOversubscribed();

      const deadline = await crowdfund.claimDeadline();
      await time.increaseTo(deadline + 1n);

      // Post-deadline: ARM forfeited, delegate should be address(0) in event
      const [, expectedRefund] = await crowdfund.computeAllocation(seeds[0].address);
      await expect(crowdfund.connect(seeds[0]).claim(seeds[0].address))
        .to.emit(crowdfund, "Allocated")
        .withArgs(seeds[0].address, 0n, expectedRefund, ethers.ZeroAddress);
    });

    it("claim() after deadline still transfers refund (refunds never expire)", async function () {
      const seeds = await setupOversubscribed();

      const deadline = await crowdfund.claimDeadline();
      await time.increaseTo(deadline + 1n);

      // Post-deadline: ARM forfeited, but refund still transfers
      const usdcBefore = await usdc.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
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
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(seed1).commit(0, USDC(10_000));

      const [tc, phase_, ws, we] = await crowdfund.getSaleStats();
      expect(tc).to.equal(USDC(10_000));
      expect(ws).to.be.gt(0);
      expect(we).to.be.gt(0);
    });

    it("should expose invite graph during sale (no phase restriction)", async function () {
      await placeTeamWallets([hop1a]);
      await crowdfund.connect(hop1a).invite(hop2a.address, 1);

      expect(await crowdfund.getInviteEdge(hop1a.address, 1)).to.equal(deployer.address); // launch team
      expect(await crowdfund.getInviteEdge(hop2a.address, 2)).to.equal(hop1a.address);
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
      await warpPastWindow();
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
      await warpPastWindow();
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
      // 70 × $15K = $1,050,000 > MIN_SALE, < the $1.8M sale


      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.phase()).to.equal(Phase.Finalized);
      expect(await crowdfund.saleSize()).to.equal(USDC(1_800_000)); // BASE

      // Hop-0 demand = $1,050,000 < $1.8M, so every seed is allocated in full.

      // Claim first seed
      const armBefore = await armToken.balanceOf(seeds[0].address);
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const armAfter = await armToken.balanceOf(seeds[0].address);

      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      expect(armAfter - armBefore).to.equal(alloc);
      expect(alloc).to.be.gt(0);
    });

    // WHY: BASE_SALE == MAX_SALE == ELASTIC_TRIGGER ($1.8M), so elastic expansion cannot change
    //      the sale size. Demand at and above the trigger (19 seeds at the $100K hop-0 cap =
    //      $1.9M) must still settle at $1.8M, with the excess refunded pro-rata.
    it("elastic expansion is a no-op (sale size stays $1.8M at the trigger)", async function () {
      expect(await crowdfund.BASE_SALE()).to.equal(USDC(1_800_000));
      expect(await crowdfund.MAX_SALE()).to.equal(USDC(1_800_000));
      expect(await crowdfund.ELASTIC_TRIGGER()).to.equal(USDC(1_800_000));

      const seeds = allSigners.slice(1, 20);
      for (const s of seeds) {
        await fundAndApprove(s, USDC(100_000));
      }
      await crowdfund.addSeeds(seeds.map(s => s.address));
      for (const s of seeds) {
        await crowdfund.connect(s).commit(0, USDC(100_000));
      }

      await warpPastWindow();
      await crowdfund.finalize();

      expect(await crowdfund.saleSize()).to.equal(USDC(1_800_000));
      const [alloc, refund] = await crowdfund.computeAllocation(seeds[0].address);
      const accepted = (USDC(100_000) * USDC(1_800_000)) / USDC(1_900_000);
      expect(alloc).to.equal(accepted * 10n ** 12n);
      expect(refund).to.equal(USDC(100_000) - accepted);
    });

    // WHY: Below-minimum demand triggers refundMode on finalize(). Both participants
    // must be able to claim full USDC refunds afterward.
    it("below-minimum finalize → claimRefund for all participants", async function () {
      await setupActive([seed1, seed2]);
      await crowdfund.connect(seed1).commit(0, USDC(15_000));
      await crowdfund.connect(seed2).commit(0, USDC(10_000));
      // Total: $25K << $250K minimum

      await warpPastWindow();
      // finalize enters refundMode (below MIN_SALE)
      await crowdfund.finalize();
      expect(await crowdfund.refundMode()).to.be.true;

      // Both can claimRefund after refundMode finalization
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
      await warpPastWindow();
      await crowdfund.finalize();

      // Claim ARM
      await crowdfund.connect(seeds[0]).claim(seeds[0].address);
      const armBalance = await armToken.balanceOf(seeds[0].address);
      expect(armBalance).to.be.gt(0);

      // Self-delegate to activate voting power (ERC20Votes)
      await armToken.connect(seeds[0]).delegate(seeds[0].address);

      const votingPower = await armToken.getVotes(seeds[0].address);
      expect(votingPower).to.equal(armBalance);
    });
  });
});
