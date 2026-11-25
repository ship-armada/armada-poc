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
  let team1: SignerWithAddress;
  let team2: SignerWithAddress;
  let inviteeA: SignerWithAddress;
  let inviteeB: SignerWithAddress;
  let inviteeC: SignerWithAddress;
  let inviteeD: SignerWithAddress;
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
      { name: "inviter", type: "address" },
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

  // Setup helper: the launch team places the hop-1 team inviter wallet (the only tier that can
  // invite; its links bring invitees into hop-2) and advances to window start. The launch
  // team's hop-1 budget is one placement, so callers pass a single wallet.
  async function setupWithTeamWallets(teamWallets: SignerWithAddress[]) {
    const ws = Number(await crowdfund.windowStart());
    if ((await time.latest()) < ws) await time.increaseTo(ws);
    for (const w of teamWallets) await crowdfund.launchTeamInvite(w.address, 0);
  }

  // Build an EIP-712 invite value object (bearer credential: signs inviter's own address)
  function inviteValue(
    inviter: string,
    fromHop: number,
    nonce: number,
    deadline: number
  ) {
    return { inviter, fromHop, nonce, deadline };
  }

  // Sign an invite using EIP-712 (bearer credential: signer signs their own address)
  async function signInvite(
    signer: SignerWithAddress,
    fromHop: number,
    nonce: number,
    deadline: number
  ): Promise<string> {
    const value = inviteValue(signer.address, fromHop, nonce, deadline);
    return signer.signTypedData(domain, inviteTypes, value);
  }

  // Get a deadline far in the future
  async function futureDeadline(): Promise<number> {
    return (await time.latest()) + ONE_DAY;
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    [deployer, team1, team2, inviteeA, inviteeB, inviteeC, inviteeD, treasury, outsider, alice] =
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
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    // Fund ARM to crowdfund (enough for MAX_SALE) and load
    const CROWDFUND_ARM_FUNDING = ARM(1_800_000);
    await armToken.transfer(cfAddr, CROWDFUND_ARM_FUNDING);
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());

    // Fund potential participants with USDC
    for (const signer of [team1, team2, inviteeA, inviteeB, inviteeC, inviteeD, alice]) {
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
      // team1 is a hop-1 team wallet; signs an invite for inviteeA to join at hop-2
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      const signature = await signInvite(
        team1,
        1, // fromHop
        nonce,
        deadline
      );

      const commitAmount = USDC(1_000);
      const tx = await crowdfund
        .connect(inviteeA)
        .commitWithInvite(team1.address, 1, nonce, deadline, signature, commitAmount);

      // Verify Invited event with the actual nonce (not 0)
      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(team1.address, inviteeA.address, 2, nonce);

      // Verify Committed event
      await expect(tx)
        .to.emit(crowdfund, "Committed")
        .withArgs(inviteeA.address, 2, commitAmount);

      // Verify on-chain state
      expect(await crowdfund.isWhitelisted(inviteeA.address, 2)).to.be.true;
      expect(await crowdfund.totalCommitted()).to.equal(commitAmount);
      expect(await crowdfund.usedNonces(team1.address, nonce)).to.be.true;
    });

    it("should revert when deadline has passed", async function () {
      await setupWithTeamWallets([team1]);
      const pastDeadline = (await time.latest()) - 1;
      const nonce = 1;

      const signature = await signInvite(
        team1,
        1,
        nonce,
        pastDeadline
      );

      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(team1.address, 1, nonce, pastDeadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invite expired");
    });

    it("should revert when nonce is zero", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();

      const signature = await signInvite(team1, 1, 0, deadline);

      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(team1.address, 1, 0, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: zero nonce");
    });

    it("should revert when nonce is reused", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 42;

      // First use succeeds
      const sig1 = await signInvite(team1, 1, nonce, deadline);
      await crowdfund
        .connect(inviteeA)
        .commitWithInvite(team1.address, 1, nonce, deadline, sig1, USDC(1_000));

      // Second use with same nonce (different invitee) should fail — nonce consumed
      const sig2 = await signInvite(team1, 1, nonce, deadline);
      await expect(
        crowdfund
          .connect(inviteeB)
          .commitWithInvite(team1.address, 1, nonce, deadline, sig2, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert when nonce has been revoked", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 7;

      // Seed1 revokes the nonce before it's used
      await crowdfund.connect(team1).revokeInviteNonce(nonce);

      const signature = await signInvite(team1, 1, nonce, deadline);

      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert with invalid signature (wrong signer)", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      // outsider signs instead of team1
      const signature = await signInvite(
        outsider,
        1,
        nonce,
        deadline
      );

      // inviteeA calls with inviter=team1, but signature is from outsider
      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invalid invite signature");
    });

    it("should revert when claimed inviter does not match signer", async function () {
      // team1 signs a bearer invite (signing their own address)
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      const signature = await signInvite(team1, 1, nonce, deadline);

      // Caller passes outsider.address as inviter — ECDSA recovery yields team1,
      // which doesn't match outsider, so SignatureChecker fails
      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(outsider.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: invalid invite signature");
    });

    it("bearer invite can be redeemed by any address", async function () {
      // team1 signs one bearer invite (no invitee in signature)
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 1;

      const signature = await signInvite(team1, 1, nonce, deadline);

      // inviteeA redeems the bearer credential
      const commitAmount = USDC(1_000);
      const tx = await crowdfund
        .connect(inviteeA)
        .commitWithInvite(team1.address, 1, nonce, deadline, signature, commitAmount);

      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(team1.address, inviteeA.address, 2, nonce);

      expect(await crowdfund.isWhitelisted(inviteeA.address, 2)).to.be.true;
    });

    it("should revert when inviter budget is exhausted", async function () {
      // WHY: each signed link spends one of the inviter's slots, so a leaked or reused set of
      // links cannot whitelist more invitees than the inviter's budget allows.
      // team1 has 100 invite slots (1 invitesReceived * 100 maxInvites at hop-1)
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const invitees = allSigners.slice(99, 200); // 101 invitees

      // Use all 100 invite slots via signed invites
      for (let i = 0; i < 100; i++) {
        await fundAndApprove(invitees[i], USDC(100));
        const sig = await signInvite(team1, 1, i + 1, deadline);
        await crowdfund
          .connect(invitees[i])
          .commitWithInvite(team1.address, 1, i + 1, deadline, sig, USDC(100));
      }

      // 101st invite should fail
      await fundAndApprove(invitees[100], USDC(100));
      const sig101 = await signInvite(team1, 1, 101, deadline);
      await expect(
        crowdfund
          .connect(invitees[100])
          .commitWithInvite(team1.address, 1, 101, deadline, sig101, USDC(100))
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
    });

    it("should revert after window end", async function () {
      await setupWithTeamWallets([team1]);

      const deadline = (await time.latest()) + 30 * ONE_DAY;
      const nonce = 1;

      const signature = await signInvite(team1, 1, nonce, deadline);

      // Advance past window end
      await time.increaseTo((await crowdfund.windowEnd()) + 1n);

      await expect(
        crowdfund
          .connect(inviteeA)
          .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: not active window");
    });

    // WHY: known contributors (hop-0) cannot invite (HOP0_MAX_INVITES = 0), so a link they
    // sign with fromHop=0 must be rejected even though the signature itself is valid.
    it("should revert with fromHop=0 (a known contributor's link is rejected)", async function () {
      await crowdfund.addSeeds([team2.address]); // team2 used here as a hop-0 known contributor
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(team2, 0, nonce, deadline);

      await expect(
        crowdfund
          .connect(inviteeB)
          .commitWithInvite(team2.address, 0, nonce, deadline, signature, USDC(500))
      ).to.be.revertedWith("ArmadaCrowdfund: invite limit reached");
      expect(await crowdfund.isWhitelisted(inviteeB.address, 1)).to.be.false;
    });

    it("should revert with fromHop=2 (hop-2 cannot invite further)", async function () {
      // Create a hop-2 address: team1 (hop-1) → inviteeA (hop-2)
      await setupWithTeamWallets([team1]);
      await crowdfund.connect(team1).invite(inviteeA.address, 1);

      // inviteeA (hop-2) signs invite with fromHop=2
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(inviteeA, 2, nonce, deadline);

      // Contract checks fromHop < NUM_HOPS - 1 (i.e., fromHop < 2)
      await expect(
        crowdfund
          .connect(inviteeC)
          .commitWithInvite(inviteeA.address, 2, nonce, deadline, signature, USDC(500))
      ).to.be.revertedWith("ArmadaCrowdfund: max hop reached");
    });

    it("should revert when caller is launchTeam", async function () {
      // team1 signs invite for deployer (who is launchTeam)
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 1;
      const signature = await signInvite(team1, 1, nonce, deadline);

      await fundAndApprove(deployer, USDC(1_000));

      // The invite registration whitelists deployer at hop-2, then
      // commit() fires require(msg.sender != launchTeam)
      await expect(
        crowdfund
          .connect(deployer)
          .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: launch team cannot commit");
    });

    it("should revert when invitee already at maxInvitesReceived", async function () {
      // WHY: hop-2 stacks up to maxInvitesReceived=20 invites ($10K of cap each). A link that
      // would push an invitee past the limit must revert, and the revert must roll back the
      // nonce so the inviter's link is not burned. A link that lands the 20th slot still works.
      await setupWithTeamWallets([team1]);
      for (let i = 0; i < 19; i++) {
        await crowdfund.connect(team1).invite(alice.address, 1);
      }
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(19);

      const deadline = await futureDeadline();

      // The 20th invite arrives via a signed link and stacks (cap 20 × $10K = $200K)
      const sig20 = await signInvite(team1, 1, 1, deadline);
      await crowdfund
        .connect(alice)
        .commitWithInvite(team1.address, 1, 1, deadline, sig20, USDC(1_000));
      expect(await crowdfund.getInvitesReceived(alice.address, 2)).to.equal(20);
      expect(await crowdfund.getEffectiveCap(alice.address, 2)).to.equal(USDC(200_000));

      // A 21st invite via a link reverts: alice is at maxInvitesReceived for hop-2
      const nonce = 2;
      const signature = await signInvite(team1, 1, nonce, deadline);
      await expect(
        crowdfund
          .connect(alice)
          .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000))
      ).to.be.revertedWith("ArmadaCrowdfund: max invites received");
      expect(await crowdfund.usedNonces(team1.address, nonce)).to.be.false;
    });
  });

  // ============================================================
  // revokeInviteNonce
  // ============================================================

  describe("revokeInviteNonce", function () {
    it("should revoke a nonce and emit InviteNonceRevoked", async function () {
      const nonce = 99;

      const tx = await crowdfund.connect(team1).revokeInviteNonce(nonce);

      await expect(tx)
        .to.emit(crowdfund, "InviteNonceRevoked")
        .withArgs(team1.address, nonce);

      // Verify nonce is marked as used
      expect(await crowdfund.usedNonces(team1.address, nonce)).to.be.true;
    });

    it("should revert when revoking nonce zero", async function () {
      await expect(
        crowdfund.connect(team1).revokeInviteNonce(0)
      ).to.be.revertedWith("ArmadaCrowdfund: zero nonce");
    });

    it("should revert when revoking an already used nonce", async function () {
      // Use the nonce via commitWithInvite first
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 5;

      const signature = await signInvite(team1, 1, nonce, deadline);
      await crowdfund
        .connect(inviteeA)
        .commitWithInvite(team1.address, 1, nonce, deadline, signature, USDC(1_000));

      // Now team1 tries to revoke the already-used nonce
      await expect(
        crowdfund.connect(team1).revokeInviteNonce(nonce)
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });

    it("should revert when revoking an already revoked nonce", async function () {
      const nonce = 10;

      await crowdfund.connect(team1).revokeInviteNonce(nonce);

      await expect(
        crowdfund.connect(team1).revokeInviteNonce(nonce)
      ).to.be.revertedWith("ArmadaCrowdfund: nonce already used");
    });
  });

  // ============================================================
  // commitWithInvite amount boundary tests
  // ============================================================

  describe("commitWithInvite amount boundaries", function () {
    it("commitWithInvite with amount=0 reverts", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 100;

      const signature = await signInvite(team1, 1, nonce, deadline);

      await expect(
        crowdfund.connect(inviteeA).commitWithInvite(
          team1.address, 1, nonce, deadline, signature, 0n
        )
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    it("commitWithInvite with amount < MIN_COMMIT ($100) reverts", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 101;

      const signature = await signInvite(team1, 1, nonce, deadline);

      // $99.999999 (one wei below MIN_COMMIT)
      await expect(
        crowdfund.connect(inviteeA).commitWithInvite(
          team1.address, 1, nonce, deadline, signature, USDC(100) - 1n
        )
      ).to.be.revertedWith("ArmadaCrowdfund: below minimum commitment");
    });

    it("commitWithInvite with exactly MIN_COMMIT ($100) succeeds", async function () {
      await setupWithTeamWallets([team1]);
      const deadline = await futureDeadline();
      const nonce = 102;

      const signature = await signInvite(team1, 1, nonce, deadline);

      await crowdfund.connect(inviteeA).commitWithInvite(
        team1.address, 1, nonce, deadline, signature, USDC(100)
      );

      const committed = await crowdfund.getCommitment(inviteeA.address, 2);
      expect(committed).to.equal(USDC(100));
    });
  });

  // ============================================================
  // Direct invite() nonce=0 verification
  // ============================================================

  describe("Direct invite nonce", function () {
    it("should emit Invited with nonce=0 for direct invite()", async function () {
      await setupWithTeamWallets([team1]);

      const tx = await crowdfund.connect(team1).invite(inviteeA.address, 1);

      await expect(tx)
        .to.emit(crowdfund, "Invited")
        .withArgs(team1.address, inviteeA.address, 2, 0);
    });
  });
});
