// ABOUTME: Hardhat integration tests for the OZ Multicall mixin on ArmadaCrowdfund (§5.4 of MULTICALL_EVAL.md).
// ABOUTME: Covers approve+multicall pipeline, atomic revert on insufficient allowance, and event ordering.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM  = (n: number) => ethers.parseUnits(n.toString(), 18);

// Hop-2 slot cap (mirrors ArmadaCrowdfund.HOP2_CAP_USDC).
const HOP2_CAP = USDC(10_000);

// A hop-1 team inviter wallet's bundle: invite 2 contributors to hop-2, invite
// itself to hop-2, then commit its $10K hop-2 slot. Known contributors (hop-0)
// cannot invite, so this is the invite-bundling flow that remains.
const SELF_FILL_TOTAL = HOP2_CAP;

describe("Crowdfund Multicall", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let teamWallet: SignerWithAddress;
  let treasury: SignerWithAddress;
  let inviteeA: SignerWithAddress;
  let inviteeB: SignerWithAddress;

  beforeEach(async function () {
    [deployer, teamWallet, treasury, inviteeA, inviteeB] = await ethers.getSigners();

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
      deployer.address,    // launchTeam
      deployer.address,    // securityCouncil
      openTimestamp,
    );
    await crowdfund.waitForDeployment();
    const cfAddr = await crowdfund.getAddress();

    await armToken.addToWhitelist(cfAddr);
    await armToken.initAuthorizedDelegators([cfAddr]);

    await armToken.transfer(cfAddr, ARM(1_800_000));
    await crowdfund.loadArm();

    // launchTeamInvite requires block.timestamp >= windowStart, so warp first.
    await time.increaseTo(await crowdfund.windowStart());
    await crowdfund.launchTeamInvite(teamWallet.address, 0); // hop-1 team inviter wallet
  });

  // ============ Bundle builders ============
  // WHY: every test in this suite calls multicall with the same bundle shape.
  // Encoding lives here so test bodies focus on assertions.

  function teamWalletBundle(selfAddress: string): string[] {
    const iface = crowdfund.interface;
    return [
      iface.encodeFunctionData("invite", [inviteeA.address, 1]),
      iface.encodeFunctionData("invite", [inviteeB.address, 1]),
      iface.encodeFunctionData("invite", [selfAddress, 1]),        // team wallet joins hop-2
      iface.encodeFunctionData("commit", [2, HOP2_CAP]),           // ...and commits its slot
    ];
  }

  // =====================================================================

  // WHY: end-to-end demonstration that the multicall mixin lets a team wallet
  // issue its invites and take its own hop-2 slot in one wallet signature. The
  // bundle relies on intra-bundle state visibility — the hop-2 commit only
  // becomes valid (whitelist + effectiveCap) AFTER the self-invite lands. If that
  // ordering assumption were broken, the call would revert; if an ordering bug
  // ever slipped into a Solidity upgrade or OZ Multicall change, this catches it.
  it("team wallet issues invites and fills its own slot in one multicall", async () => {
    await usdc.mint(teamWallet.address, SELF_FILL_TOTAL);
    await usdc.connect(teamWallet).approve(await crowdfund.getAddress(), SELF_FILL_TOTAL);

    const calls = teamWalletBundle(teamWallet.address);
    expect(calls.length).to.equal(4);

    await crowdfund.connect(teamWallet).multicall(calls);

    expect(await crowdfund.isWhitelisted(inviteeA.address, 2)).to.equal(true);
    expect(await crowdfund.isWhitelisted(inviteeB.address, 2)).to.equal(true);
    expect(await crowdfund.getInvitesReceived(teamWallet.address, 2)).to.equal(1);
    expect(await crowdfund.getCommitment(teamWallet.address, 2)).to.equal(HOP2_CAP);
    expect(await crowdfund.getInvitesRemaining(teamWallet.address, 1)).to.equal(97);
    expect(await crowdfund.totalCommitted()).to.equal(SELF_FILL_TOTAL);
    expect(await usdc.balanceOf(teamWallet.address)).to.equal(0n);
  });

  // WHY: confirms the two-tx pipeline the frontend will actually use.
  // USDC `approve` cannot be bundled inside the crowdfund's multicall
  // (it's on a separate contract), so the live flow is: (1) approve total,
  // (2) multicall. This test exercises both txs and asserts on the
  // observable post-state. A future EIP-2612 permit integration could
  // collapse this to one tx; until then, this is the canonical path.
  it("approve + multicall pipeline lands the expected on-chain state", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(teamWallet.address, SELF_FILL_TOTAL);

    // Tx 1: approve. Allowance starts at 0; bumping to exactly the bundle total.
    const txApprove = await usdc.connect(teamWallet).approve(cfAddr, SELF_FILL_TOTAL);
    await txApprove.wait();
    expect(await usdc.allowance(teamWallet.address, cfAddr)).to.equal(SELF_FILL_TOTAL);

    // Tx 2: multicall. Single wallet signature.
    const calls = teamWalletBundle(teamWallet.address);
    const txMulti = await crowdfund.connect(teamWallet).multicall(calls);
    const receipt = await txMulti.wait();

    expect(receipt.status).to.equal(1);
    // Allowance fully consumed (the commit's safeTransferFrom decrements it).
    expect(await usdc.allowance(teamWallet.address, cfAddr)).to.equal(0n);
    // Crowdfund holds all the USDC.
    expect(await usdc.balanceOf(cfAddr)).to.equal(SELF_FILL_TOTAL);
    expect(await crowdfund.totalCommitted()).to.equal(SELF_FILL_TOTAL);
  });

  // WHY: critical atomicity property. The wallet approves only $5K but the
  // bundle commits $10K. When the final commit hits the allowance shortfall,
  // the underlying ERC20 transferFrom reverts. OZ Multicall propagates that
  // revert; Solidity rolls back the entire tx. We must verify NOTHING from the
  // bundle persisted — no invites, no commits, no allowance burn. Without
  // atomicity, a partial bundle could leave invites issued with no commit.
  it("rejects multicall when total USDC exceeds approval", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(teamWallet.address, SELF_FILL_TOTAL);
    const shortApproval = HOP2_CAP / 2n;
    await usdc.connect(teamWallet).approve(cfAddr, shortApproval);

    const calls = teamWalletBundle(teamWallet.address);
    // The revert comes from the commit's transferFrom (allowance), after the 3 invites ran.
    await expect(crowdfund.connect(teamWallet).multicall(calls)).to.be.revertedWith("ERC20: insufficient allowance");

    // All bundle state rolled back: no invites landed and no slot was taken.
    // The team wallet's hop-1 invitesReceived is set by the launch-team placement (1).
    expect(await crowdfund.getInvitesReceived(teamWallet.address, 1)).to.equal(1);
    expect(await crowdfund.getInvitesReceived(teamWallet.address, 2)).to.equal(0);
    expect(await crowdfund.isWhitelisted(inviteeA.address, 2)).to.equal(false);
    expect(await crowdfund.isWhitelisted(inviteeB.address, 2)).to.equal(false);
    expect(await crowdfund.getInvitesRemaining(teamWallet.address, 1)).to.equal(100);
    expect(await crowdfund.getCommitment(teamWallet.address, 2)).to.equal(0n);
    expect(await crowdfund.totalCommitted()).to.equal(0n);
    // Allowance untouched too (transferFrom never debited).
    expect(await usdc.allowance(teamWallet.address, cfAddr)).to.equal(shortApproval);
  });

  // WHY: a bundle promises "you'll issue N invites and commit $X". The
  // frontend builds that promise from the planned call
  // sequence; the contract MUST emit events in matching order so that
  // off-chain indexers / the MyPosition card / NodeSphere render the
  // resulting graph correctly. If the event order ever desynchronised
  // from the call order (e.g. via batched / deferred emits), downstream
  // UI state would corrupt silently. This test pins the contract-side
  // guarantee.
  it("emits Invited + Committed events in expected order", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(teamWallet.address, SELF_FILL_TOTAL);
    await usdc.connect(teamWallet).approve(cfAddr, SELF_FILL_TOTAL);

    const calls = teamWalletBundle(teamWallet.address);
    const tx = await crowdfund.connect(teamWallet).multicall(calls);
    const receipt = await tx.wait();

    // Filter to crowdfund logs only and decode. ArmadaToken emits no events
    // during commit() since transferFrom is on USDC, not ARM.
    const parsed: { name: string; args: any }[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== cfAddr.toLowerCase()) continue;
      try {
        const decoded = crowdfund.interface.parseLog(log);
        if (decoded) parsed.push({ name: decoded.name, args: decoded.args });
      } catch (e) {
        // ignore non-crowdfund logs that may have matched address but failed decode
      }
    }

    // Expected order: 3× Invited (A, B, self), then 1× Committed (hop-2).
    const eventNames = parsed.map((p) => p.name);
    expect(eventNames).to.deep.equal(["Invited", "Invited", "Invited", "Committed"]);

    // Spot-check the invitees and the committed hop are in call order.
    const invited = parsed.filter((p) => p.name === "Invited");
    expect(invited[0].args[1]).to.equal(inviteeA.address);
    expect(invited[1].args[1]).to.equal(inviteeB.address);
    expect(invited[2].args[1]).to.equal(teamWallet.address);
    const committed = parsed.filter((p) => p.name === "Committed");
    expect(committed[0].args[1]).to.equal(2);
  });
});
