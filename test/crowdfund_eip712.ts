// ABOUTME: Tests for EIP-712 signed invite flow in ArmadaCrowdfund.
// ABOUTME: Covers commitWithInvite(), revokeInviteNonce(), and related edge cases.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Phase enum (must match IArmadaCrowdfund.sol)
const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

// Time constants
const ONE_DAY = 86400;
const ONE_WEEK = 7 * ONE_DAY;

// USDC amounts (6 decimals)
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
// ARM amounts (18 decimals)
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund EIP-712 Invites", function () {
  // Contracts
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  // Signers
  let deployer: SignerWithAddress;
  let seed1: SignerWithAddress;
  let seed2: SignerWithAddress;
  let hop1a: SignerWithAddress;
  let hop1b: SignerWithAddress;
  let hop1c: SignerWithAddress;
  let hop1d: SignerWithAddress;
  let treasury: SignerWithAddress;
  let outsider: SignerWithAddress;

  // EIP-712 domain (set after deploy)
  let domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };

  const inviteTypes = {
    Invite: [
      { name: "invitee", type: "address" },
      { name: "fromHop", type: "uint8" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  // Fund participants with USDC and approve crowdfund
  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  // Setup helper: add seeds and advance to window start
  async function setupWithSeeds(seeds: SignerWithAddress[]) {
    await crowdfund.addSeeds(seeds.map((s) => s.address));
    const ws = Number(await crowdfund.windowStart());
    if ((await time.latest()) < ws) await time.increaseTo(ws);
  }

  // Build an EIP-712 invite value object
  function inviteValue(
    invitee: string,
    fromHop: number,
    nonce: number,
    deadline: number
  ) {
    return { invitee, fromHop, nonce, deadline };
  }

  // Sign an invite using EIP-712
  async function signInvite(
    signer: SignerWithAddress,
    invitee: string,
    fromHop: number,
    nonce: number,
    deadline: number
  ): Promise<string> {
    const value = inviteValue(invitee, fromHop, nonce, deadline);
    return signer.signTypedData(domain, inviteTypes, value);
  }

  // Get a deadline far in the future
  async function futureDeadline(): Promise<number> {
    return (await time.latest()) + ONE_DAY;
  }

  beforeEach(async function () {
    const allSigners = await ethers.getSigners();
    [deployer, seed1, seed2, hop1a, hop1b, hop1c, hop1d, treasury, outsider] =
      allSigners;

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
      deployer.address, // launchTeam
      deployer.address, // securityCouncil
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());

    // Fund ARM to crowdfund (enough for MAX_SALE) and load
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    await armToken.transfer(await crowdfund.getAddress(), CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();

    // Fund potential participants with USDC
    for (const signer of [seed1, seed2, hop1a, hop1b, hop1c, hop1d]) {
      await fundAndApprove(signer, USDC(20_000));
    }

    // Set EIP-712 domain
    domain = {
      name: "ArmadaCrowdfund",
      version: "1",
      chainId: 31337,
      verifyingContract: await crowdfund.getAddress(),
    };
  });

  // ============================================================
  // commitWithInvite
  // ============================================================

  describe("commitWithInvite", function () {
    it("should accept a valid signed invite and commit USDC", async function () {
      // seed1 is hop-0; signs an invite for hop1a to join at hop-1
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      const signature = await signInvite(
        seed1,
        hop1a.address,
        0, // fromHop
        nonce,
        deadline
      );

      const commitAmount = USDC(1_000);
      const tx = await crowdfund
        .connect(hop1a)
        .commitWithInvite(seed1.address, 0, nonce, deadline, signature, commitAmount);

      // Verify Invited event with the actual nonce (not 0)
      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(seed1.address, hop1a.address, 1, nonce);

      // Verify Committed event
      await expect(tx)
        .to.emit(crowdfund, "Committed")
        .withArgs(hop1a.address, commitAmount, commitAmount, 1);

      // Verify on-chain state
      expect(await crowdfund.isWhitelisted(hop1a.address, 1)).to.be.true;
      expect(await crowdfund.totalCommitted()).to.equal(commitAmount);
      expect(await crowdfund.usedNonces(seed1.address, nonce)).to.be.true;
    });

    it("should revert when deadline has passed", async function () {
      await setupWithSeeds([seed1]);
      const pastDeadline = (await time.latest()) - 1;
      const nonce = 1;

      const signature = await signInvite(
        seed1,
        hop1a.address,
        0,
        nonce,
        pastDeadline
      );

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, pastDeadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invite expired");
    });

    it("should revert when nonce is zero", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();

      const signature = await signInvite(seed1, hop1a.address, 0, 0, deadline);

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, 0, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: zero nonce");
    });

    it("should revert when nonce is reused", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 42;

      // First use succeeds
      const sig1 = await signInvite(seed1, hop1a.address, 0, nonce, deadline);
      await crowdfund
        .connect(hop1a)
        .commitWithInvite(seed1.address, 0, nonce, deadline, sig1, USDC(1_000));

      // Second use with same nonce (different invitee) should fail
      const sig2 = await signInvite(seed1, hop1b.address, 0, nonce, deadline);
      await expect(
        crowdfund
          .connect(hop1b)
          .commitWithInvite(seed1.address, 0, nonce, deadline, sig2, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert when nonce has been revoked", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 7;

      // Seed1 revokes the nonce before it's used
      await crowdfund.connect(seed1).revokeInviteNonce(nonce);

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert with invalid signature (wrong signer)", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      // outsider signs instead of seed1
      const signature = await signInvite(
        outsider,
        hop1a.address,
        0,
        nonce,
        deadline
      );

      // hop1a calls with inviter=seed1, but signature is from outsider
      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invalid invite signature");
    });

    it("should revert with tampered data (signature for different invitee)", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      // seed1 signs an invite for hop1a
      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      // hop1b tries to use the signature meant for hop1a
      await expect(
        crowdfund
          .connect(hop1b)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invalid invite signature");
    });

    it("should revert when inviter budget is exhausted", async function () {
      // seed1 has 3 invite slots (1 invitesReceived * 3 maxInvites at hop-0)
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();

      // Use all 3 invite slots via signed invites
      for (let i = 0; i < 3; i++) {
        const invitee = [hop1a, hop1b, hop1c][i];
        const sig = await signInvite(seed1, invitee.address, 0, i + 1, deadline);
        await crowdfund
          .connect(invitee)
          .commitWithInvite(seed1.address, 0, i + 1, deadline, sig, USDC(1_000));
      }

      // 4th invite should fail
      const sig4 = await signInvite(seed1, hop1d.address, 0, 4, deadline);
      await expect(
        crowdfund
          .connect(hop1d)
          .commitWithInvite(seed1.address, 0, 4, deadline, sig4, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should revert when contract is paused", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      // deployer is launchTeam, can pause
      await crowdfund.pause();

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("Pausable: paused");
    });

    it("should revert before window start", async function () {
      // Add seeds but do NOT advance time to window start
      await crowdfund.addSeeds([seed1.address]);

      const deadline = (await time.latest()) + ONE_DAY;
      const nonce = 1;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });
  });

  // ============================================================
  // revokeInviteNonce
  // ============================================================

  describe("revokeInviteNonce", function () {
    it("should revoke a nonce and emit InviteNonceRevoked", async function () {
      const nonce = 99;

      const tx = await crowdfund.connect(seed1).revokeInviteNonce(nonce);

      await expect(tx)
        .to.emit(crowdfund, "InviteNonceRevoked")
        .withArgs(seed1.address, nonce);

      // Verify nonce is marked as used
      expect(await crowdfund.usedNonces(seed1.address, nonce)).to.be.true;
    });

    it("should revert when revoking nonce zero", async function () {
      await expect(
        crowdfund.connect(seed1).revokeInviteNonce(0)
      ).to.be.revertedWith("ArmadaCrowdfund: zero nonce");
    });

    it("should revert when revoking an already used nonce", async function () {
      // Use the nonce via commitWithInvite first
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 5;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);
      await crowdfund
        .connect(hop1a)
        .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000));

      // Now seed1 tries to revoke the already-used nonce
      await expect(
        crowdfund.connect(seed1).revokeInviteNonce(nonce)
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert when revoking an already revoked nonce", async function () {
      const nonce = 10;

      await crowdfund.connect(seed1).revokeInviteNonce(nonce);

      await expect(
        crowdfund.connect(seed1).revokeInviteNonce(nonce)
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });
  });

  // ============================================================
  // Direct invite() nonce=0 verification
  // ============================================================

  describe("Direct invite nonce", function () {
    it("should emit Invited with nonce=0 for direct invite()", async function () {
      await setupWithSeeds([seed1]);

      const tx = await crowdfund.connect(seed1).invite(hop1a.address, 0);

      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(seed1.address, hop1a.address, 1, 0);
    });
  });
});
