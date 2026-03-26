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
  let alice: SignerWithAddress;
  let securityCouncil: SignerWithAddress;
  let allSigners: SignerWithAddress[];

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
    const ws = Number(await crowdfund.windowStart());
    if ((await time.latest()) < ws) await time.increaseTo(ws);
    await crowdfund.addSeeds(seeds.map((s) => s.address));
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
    allSigners = await ethers.getSigners();
    [deployer, seed1, seed2, hop1a, hop1b, hop1c, hop1d, treasury, outsider, alice] =
      allSigners;
    securityCouncil = allSigners[10];

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
      deployer.address,         // launchTeam
      securityCouncil.address,  // securityCouncil
      openTimestamp,
      false             // single-tx settlement
    );
    await crowdfund.waitForDeployment();
    await armToken.addToWhitelist(await crowdfund.getAddress());

    // Fund ARM to crowdfund (enough for MAX_SALE) and load
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    await armToken.transfer(await crowdfund.getAddress(), CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    // Fund potential participants with USDC
    for (const signer of [seed1, seed2, hop1a, hop1b, hop1c, hop1d, alice]) {
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
        .withArgs(hop1a.address, 1, commitAmount);

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

    it("should revert after window end", async function () {
      await crowdfund.addSeeds([seed1.address]);

      const deadline = (await time.latest()) + 30 * ONE_DAY;
      const nonce = 1;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      // Advance past window end
      const THREE_WEEKS = 21 * ONE_DAY;
      await time.increase(THREE_WEEKS + 1);

      await expect(
        crowdfund
          .connect(hop1a)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    it("should succeed with fromHop=1 (hop-1 inviter to hop-2 invitee)", async function () {
      // seed1 (hop-0) invites hop1a at hop-1 via direct invite
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);

      // hop1a (hop-1) signs EIP-712 invite for hop1b to join at hop-2
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(hop1a, hop1b.address, 1, nonce, deadline);

      const commitAmount = USDC(500);
      await crowdfund
        .connect(hop1b)
        .commitWithInvite(hop1a.address, 1, nonce, deadline, signature, commitAmount);

      // Verify hop1b is whitelisted at hop-2 with correct commitment
      expect(await crowdfund.isWhitelisted(hop1b.address, 2)).to.be.true;
      expect(await crowdfund.getCommitment(hop1b.address, 2)).to.equal(commitAmount);
    });

    it("should revert with fromHop=2 (hop-2 cannot invite further)", async function () {
      // Create a hop-2 address: seed1 → hop1a (hop-1) → hop1b (hop-2)
      await setupWithSeeds([seed1]);
      await crowdfund.connect(seed1).invite(hop1a.address, 0);
      await crowdfund.connect(hop1a).invite(hop1b.address, 1);

      // hop1b (hop-2) signs invite with fromHop=2
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(hop1b, hop1c.address, 2, nonce, deadline);

      // Contract checks fromHop < NUM_HOPS - 1 (i.e., fromHop < 2)
      await expect(
        crowdfund
          .connect(hop1c)
          .commitWithInvite(hop1b.address, 2, nonce, deadline, signature, USDC(500))
      ).to.be.revertedWith("ArmadaCrowdfund: max hop reached");
    });

    it("should revert when caller is launchTeam", async function () {
      // seed1 signs invite for deployer (who is launchTeam)
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(seed1, deployer.address, 0, nonce, deadline);

      await fundAndApprove(deployer, USDC(1_000));

      // The invite registration whitelists deployer at hop-1, then
      // commit() fires require(msg.sender != launchTeam)
      await expect(
        crowdfund
          .connect(deployer)
          .commitWithInvite(seed1.address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: launch team cannot commit");
    });

    it("should revert when invitee already at maxInvitesReceived", async function () {
      // Hop-1 maxInvitesReceived=10. Use 11 seeds: first 10 invite alice, 11th fails.
      const seeds = allSigners.slice(10, 21); // 11 seeds
      await setupWithSeeds(seeds);

      // 10 seeds invite alice to hop-1 via direct invite (saturates maxInvitesReceived)
      for (let i = 0; i < 10; i++) {
        await crowdfund.connect(seeds[i]).invite(alice.address, 0);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 1)).to.equal(10);

      // 11th seed signs EIP-712 invite for alice
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(seeds[10], alice.address, 0, nonce, deadline);

      await fundAndApprove(alice, USDC(1_000));

      // Should revert: alice already at maxInvitesReceived for hop-1
      await expect(
        crowdfund
          .connect(alice)
          .commitWithInvite(seeds[10].address, 0, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
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
  // commitWithInvite amount boundary tests
  // ============================================================

  describe("commitWithInvite amount boundaries", function () {
    it("commitWithInvite with amount=0 reverts", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 100;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      await expect(
        crowdfund.connect(hop1a).commitWithInvite(
          seed1.address, 0, nonce, deadline, signature, 0n
        )
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    it("commitWithInvite with amount < MIN_COMMIT ($10) reverts", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 101;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      // $9.999999 (one wei below MIN_COMMIT)
      await expect(
        crowdfund.connect(hop1a).commitWithInvite(
          seed1.address, 0, nonce, deadline, signature, USDC(10) - 1n
        )
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    it("commitWithInvite with exactly MIN_COMMIT ($10) succeeds", async function () {
      await setupWithSeeds([seed1]);
      const deadline = await futureDeadline();
      const nonce = 102;

      const signature = await signInvite(seed1, hop1a.address, 0, nonce, deadline);

      await crowdfund.connect(hop1a).commitWithInvite(
        seed1.address, 0, nonce, deadline, signature, USDC(10)
      );

      const committed = await crowdfund.getCommitment(hop1a.address, 1);
      expect(committed).to.equal(USDC(10));
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
