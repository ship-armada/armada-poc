// ABOUTME: Integration tests for the crowdfund window extension (extendWindow) across a full lifecycle.
// ABOUTME: Covers settlement of extension-period commits, cancel/refund, the event, and Safe-style batching.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Phase enum (must match IArmadaCrowdfund.sol)
const Phase = { Active: 0, Finalized: 1, Canceled: 2 };

const ONE_DAY = 86400;
const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM = (n: number) => ethers.parseUnits(n.toString(), 18);

describe("Crowdfund Window Extension (integration)", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let allSigners: SignerWithAddress[];
  let launchTeam: SignerWithAddress; // also the token timelock in this setup
  let securityCouncil: SignerWithAddress;
  let treasury: SignerWithAddress;

  async function fundAndApprove(signer: SignerWithAddress, amount: bigint) {
    await usdc.mint(signer.address, amount);
    await usdc.connect(signer).approve(await crowdfund.getAddress(), amount);
  }

  async function extend(newEnd: bigint) {
    return crowdfund.connect(launchTeam).extendWindow(newEnd);
  }

  beforeEach(async function () {
    allSigners = await ethers.getSigners();
    launchTeam = allSigners[0];
    securityCouncil = allSigners[198];
    treasury = allSigners[199];

    const MockUSDCV2 = await ethers.getContractFactory("MockUSDCV2");
    usdc = await MockUSDCV2.deploy("Mock USDC", "USDC");
    await usdc.waitForDeployment();

    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(launchTeam.address, launchTeam.address);
    await armToken.waitForDeployment();
    await armToken.initWhitelist([launchTeam.address]);

    const ArmadaCrowdfund = await ethers.getContractFactory("ArmadaCrowdfund");
    const openTimestamp = (await time.latest()) + 300;
    crowdfund = await ArmadaCrowdfund.deploy(
      await usdc.getAddress(),
      await armToken.getAddress(),
      treasury.address,
      launchTeam.address,
      securityCouncil.address,
      openTimestamp
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();
    // claim() transfers ARM and delegates atomically, so the crowdfund must be a whitelisted
    // sender and an authorized delegator on the token.
    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    await armToken.transfer(cfAddr, ARM(1_500_000));
    await crowdfund.loadArm();
    await time.increaseTo(await crowdfund.windowStart());
  });

  // WHY: the purpose of an extension is to let an undersubscribed sale keep filling. This runs
  //      a sale that only reaches the minimum because of commits made AFTER the original end,
  //      then checks those commits settle exactly like any other: finalize succeeds (not
  //      refundMode), and an extension-period committer claims ARM with delegation recorded.
  //      Numbers: 1 known contributor x $150K before the original end ($150K < MIN_SALE);
  //      10 launch-team hop-2 placements x $10K during the extension. Total $250K = MIN_SALE.
  it("commits and placements made during an extension settle through claim", async function () {
    const seed = allSigners[1];
    const lateBuyers = allSigners.slice(40, 50); // 10 hop-2 contributors placed late

    await crowdfund.connect(launchTeam).addSeed(seed.address);
    await fundAndApprove(seed, USDC(150_000));
    await crowdfund.connect(seed).commit(0, USDC(150_000));

    const originalEnd: bigint = await crowdfund.windowEnd();
    const extendedEnd = originalEnd + BigInt(3 * ONE_DAY);
    await extend(extendedEnd);

    // Move past the ORIGINAL end: without the extension, everything below would revert.
    await time.increaseTo(originalEnd + BigInt(ONE_DAY));

    for (const buyer of lateBuyers) {
      await crowdfund.connect(launchTeam).launchTeamInvite(buyer.address, 1);
      await fundAndApprove(buyer, USDC(10_000));
      await crowdfund.connect(buyer).commit(2, USDC(10_000));
    }

    await expect(crowdfund.finalize()).to.be.revertedWith("ArmadaCrowdfund: window not ended");

    await time.increaseTo(extendedEnd + 1n);
    await crowdfund.finalize();
    expect(await crowdfund.phase()).to.equal(Phase.Finalized);
    expect(await crowdfund.refundMode()).to.equal(false);

    // An extension-period committer receives the full $10K as ARM.
    const lateBuyer = lateBuyers[0];
    const delegate = allSigners[190];
    await crowdfund.connect(lateBuyer).claim(delegate.address);
    expect(await armToken.balanceOf(lateBuyer.address)).to.equal(ARM(10_000));
    expect(await armToken.delegates(lateBuyer.address)).to.equal(delegate.address);
    expect(await armToken.getVotes(delegate.address)).to.equal(ARM(10_000));
  });

  // WHY: the security council's emergency cancel must keep working during an extension, and
  //      USDC committed during the extension must be fully refundable afterwards.
  it("security council can cancel during an extension and extension-period commits are refunded", async function () {
    const seed = allSigners[1];
    await crowdfund.connect(launchTeam).addSeed(seed.address);

    const originalEnd: bigint = await crowdfund.windowEnd();
    await extend(originalEnd + BigInt(2 * ONE_DAY));
    await time.increaseTo(originalEnd + BigInt(ONE_DAY));

    await fundAndApprove(seed, USDC(5_000));
    await crowdfund.connect(seed).commit(0, USDC(5_000));

    await crowdfund.connect(securityCouncil).cancel();
    expect(await crowdfund.phase()).to.equal(Phase.Canceled);

    await crowdfund.connect(seed).claimRefund();
    expect(await usdc.balanceOf(seed.address)).to.equal(USDC(5_000));

    // A canceled sale can no longer be extended.
    await expect(extend(originalEnd + BigInt(2 * ONE_DAY) + 1n)).to.be.revertedWith(
      "ArmadaCrowdfund: not active"
    );
  });

  // WHY: the indexer and apps learn about extensions from the WindowExtended event. Pins its
  //      name and argument order so a rename or reorder breaks this test, not production tooling.
  it("emits WindowExtended(previousEnd, newEnd) and is queryable from logs", async function () {
    const originalEnd: bigint = await crowdfund.windowEnd();
    const firstEnd = originalEnd + BigInt(ONE_DAY);
    const secondEnd = firstEnd + BigInt(ONE_DAY);

    await expect(extend(firstEnd))
      .to.emit(crowdfund, "WindowExtended")
      .withArgs(originalEnd, firstEnd);
    await extend(secondEnd);

    const logs = await crowdfund.queryFilter(crowdfund.filters.WindowExtended());
    expect(logs.length).to.equal(2);
    expect(logs[1].args.previousEnd).to.equal(firstEnd);
    expect(logs[1].args.newEnd).to.equal(secondEnd);
    expect(await crowdfund.windowEnd()).to.equal(secondEnd);
    expect(await crowdfund.launchTeamInviteEnd()).to.equal(secondEnd);
  });

  // WHY: the launch team operates from a Safe and batches calls through the crowdfund's
  //      Multicall. An extension must work inside a batch (msg.sender is preserved via
  //      delegatecall), e.g. extend the window and whitelist late seeds in one transaction.
  it("launch team can extend and whitelist in one multicall batch", async function () {
    const originalEnd: bigint = await crowdfund.windowEnd();
    const newEnd = originalEnd + BigInt(2 * ONE_DAY);
    const lateSeed = allSigners[5].address;

    await crowdfund.connect(launchTeam).multicall([
      crowdfund.interface.encodeFunctionData("extendWindow", [newEnd]),
      crowdfund.interface.encodeFunctionData("addSeed", [lateSeed]),
    ]);

    expect(await crowdfund.windowEnd()).to.equal(newEnd);
    expect(await crowdfund.isWhitelisted(lateSeed, 0)).to.equal(true);

    // A batch from anyone else must revert as a whole.
    await expect(
      crowdfund.connect(allSigners[6]).multicall([
        crowdfund.interface.encodeFunctionData("extendWindow", [newEnd + 1n]),
      ])
    ).to.be.revertedWith("ArmadaCrowdfund: not launch team");
  });
});
