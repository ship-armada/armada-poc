// ABOUTME: Hardhat integration tests for the OZ Multicall mixin on ArmadaCrowdfund (§5.4 of MULTICALL_EVAL.md).
// ABOUTME: Covers approve+multicall pipeline, atomic revert on insufficient allowance, and event ordering.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const ARM  = (n: number) => ethers.parseUnits(n.toString(), 18);

// Per-hop slot caps + invite budgets (mirrors ArmadaCrowdfund constants).
const HOP0_CAP = USDC(15_000);
const HOP1_CAP = USDC(4_000);
const HOP2_CAP = USDC(1_000);

// A seed wallet's self-fill plan: 3× hop-1 invites + 6× hop-2 invites,
// then commit $15K / $12K / $6K = $33K total.
const SELF_FILL_TOTAL = USDC(33_000);

describe("Crowdfund Multicall", function () {
  let crowdfund: any;
  let armToken: any;
  let usdc: any;

  let deployer: SignerWithAddress;
  let seed: SignerWithAddress;
  let treasury: SignerWithAddress;
  let outsider: SignerWithAddress;
  let delegateAddr: SignerWithAddress;

  beforeEach(async function () {
    [deployer, seed, treasury, outsider, delegateAddr] = await ethers.getSigners();

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

    // addSeeds requires block.timestamp >= windowStart, so warp first.
    await time.increaseTo(await crowdfund.windowStart());
    await crowdfund.addSeeds([seed.address]);
  });

  // ============ Bundle builders ============
  // WHY: every test in this suite calls multicall with the same self-fill
  // plan shape. Encoding lives here so test bodies focus on assertions.

  function seedSelfFillBundle(selfAddress: string): string[] {
    const iface = crowdfund.interface;
    const calls: string[] = [];
    for (let k = 0; k < 3; k++) calls.push(iface.encodeFunctionData("invite", [selfAddress, 0]));
    for (let k = 0; k < 6; k++) calls.push(iface.encodeFunctionData("invite", [selfAddress, 1]));
    calls.push(iface.encodeFunctionData("commit", [0, HOP0_CAP]));
    calls.push(iface.encodeFunctionData("commit", [1, HOP1_CAP * 3n]));
    calls.push(iface.encodeFunctionData("commit", [2, HOP2_CAP * 6n]));
    return calls;
  }

  // =====================================================================

  // WHY: end-to-end demonstration that the multicall mixin lets a seed
  // execute their entire self-fill plan in one wallet signature. The 12-call
  // bundle relies on intra-bundle state visibility — hop-2 invites only
  // become valid AFTER the hop-1 self-invites land, and hop-1/2 commits
  // only become valid (whitelist + effectiveCap) after their hop's
  // self-invites land. If any of these intra-bundle ordering assumptions
  // were broken, the call would revert; if a single ordering bug ever
  // slipped into a Solidity upgrade or OZ Multicall change, this test
  // catches it.
  it("seed wallet fills entire tree in one multicall", async () => {
    await usdc.mint(seed.address, SELF_FILL_TOTAL);
    await usdc.connect(seed).approve(await crowdfund.getAddress(), SELF_FILL_TOTAL);

    const calls = seedSelfFillBundle(seed.address);
    expect(calls.length).to.equal(12);

    await crowdfund.connect(seed).multicall(calls);

    expect(await crowdfund.getInvitesReceived(seed.address, 1)).to.equal(3);
    expect(await crowdfund.getInvitesReceived(seed.address, 2)).to.equal(6);
    expect(await crowdfund.getCommitment(seed.address, 0)).to.equal(HOP0_CAP);
    expect(await crowdfund.getCommitment(seed.address, 1)).to.equal(HOP1_CAP * 3n);
    expect(await crowdfund.getCommitment(seed.address, 2)).to.equal(HOP2_CAP * 6n);
    expect(await crowdfund.totalCommitted()).to.equal(SELF_FILL_TOTAL);
    expect(await usdc.balanceOf(seed.address)).to.equal(0n);
  });

  // WHY: confirms the two-tx pipeline the frontend will actually use.
  // USDC `approve` cannot be bundled inside the crowdfund's multicall
  // (it's on a separate contract), so the live flow is: (1) approve total,
  // (2) multicall. This test exercises both txs and asserts on the
  // observable post-state. A future EIP-2612 permit integration could
  // collapse this to one tx; until then, this is the canonical path.
  it("approve + multicall pipeline lands the expected on-chain state", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(seed.address, SELF_FILL_TOTAL);

    // Tx 1: approve. Allowance starts at 0; bumping to exactly the bundle total.
    const txApprove = await usdc.connect(seed).approve(cfAddr, SELF_FILL_TOTAL);
    await txApprove.wait();
    expect(await usdc.allowance(seed.address, cfAddr)).to.equal(SELF_FILL_TOTAL);

    // Tx 2: multicall. Single wallet signature.
    const calls = seedSelfFillBundle(seed.address);
    const txMulti = await crowdfund.connect(seed).multicall(calls);
    const receipt = await txMulti.wait();

    expect(receipt.status).to.equal(1);
    // Allowance fully consumed (each commit safeTransferFrom decrements it).
    expect(await usdc.allowance(seed.address, cfAddr)).to.equal(0n);
    // Crowdfund holds all the USDC.
    expect(await usdc.balanceOf(cfAddr)).to.equal(SELF_FILL_TOTAL);
    expect(await crowdfund.totalCommitted()).to.equal(SELF_FILL_TOTAL);
  });

  // WHY: critical atomicity property. The user approves only $20K but the
  // self-fill plan needs $33K. When the hop-2 commit (final commit in the
  // bundle) hits an allowance shortfall, the underlying ERC20 transferFrom
  // reverts. OZ Multicall propagates that revert; Solidity rolls back the
  // entire tx. We must verify NOTHING from the bundle persisted — no
  // invites, no commits, no allowance burn. Without atomicity, a partial
  // self-fill could leave a user in a broken state (whitelisted at hop-2
  // but with no allowance to commit).
  it("rejects multicall when total USDC exceeds approval", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(seed.address, SELF_FILL_TOTAL);
    // Only approve enough for hop-0 + hop-1 ($27K), not enough for the
    // final $6K hop-2 commit.
    const shortApproval = HOP0_CAP + HOP1_CAP * 3n;
    await usdc.connect(seed).approve(cfAddr, shortApproval);

    const calls = seedSelfFillBundle(seed.address);
    await expect(crowdfund.connect(seed).multicall(calls)).to.be.reverted;

    // All bundle state rolled back: zero invites stacked at hop-1/2.
    // Seed's hop-0 invitesReceived is set by addSeeds (initial state = 1);
    // hop-1 and hop-2 entries don't exist until the seed self-invites.
    expect(await crowdfund.getInvitesReceived(seed.address, 0)).to.equal(1);  // initial seed state
    expect(await crowdfund.getInvitesReceived(seed.address, 1)).to.equal(0);
    expect(await crowdfund.getInvitesReceived(seed.address, 2)).to.equal(0);
    expect(await crowdfund.getCommitment(seed.address, 0)).to.equal(0n);
    expect(await crowdfund.getCommitment(seed.address, 1)).to.equal(0n);
    expect(await crowdfund.getCommitment(seed.address, 2)).to.equal(0n);
    expect(await crowdfund.totalCommitted()).to.equal(0n);
    // Allowance untouched too (transferFrom never debited).
    expect(await usdc.allowance(seed.address, cfAddr)).to.equal(shortApproval);
  });

  // WHY: the self-fill UX promises the user "you'll issue 9 invites and
  // commit $33K". The frontend builds that promise from the planned call
  // sequence; the contract MUST emit events in matching order so that
  // off-chain indexers / the MyPosition card / NodeSphere render the
  // resulting graph correctly. If the event order ever desynchronised
  // from the call order (e.g. via batched / deferred emits), downstream
  // UI state would corrupt silently. This test pins the contract-side
  // guarantee.
  it("emits Invited + Committed events in expected order", async () => {
    const cfAddr = await crowdfund.getAddress();
    await usdc.mint(seed.address, SELF_FILL_TOTAL);
    await usdc.connect(seed).approve(cfAddr, SELF_FILL_TOTAL);

    const calls = seedSelfFillBundle(seed.address);
    const tx = await crowdfund.connect(seed).multicall(calls);
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

    // Expected order: 9× Invited, then 3× Committed (hop-0, hop-1, hop-2).
    const eventNames = parsed.map((p) => p.name);
    expect(eventNames).to.deep.equal([
      "Invited", "Invited", "Invited",          // hop-1 self-invites
      "Invited", "Invited", "Invited",
      "Invited", "Invited", "Invited",          // hop-2 self-invites (issued from hop-1)
      "Committed",                              // hop-0 commit
      "Committed",                              // hop-1 commit
      "Committed",                              // hop-2 commit
    ]);

    // Spot-check the Committed event hops are in the right order.
    const committed = parsed.filter((p) => p.name === "Committed");
    expect(committed[0].args[1]).to.equal(0);
    expect(committed[1].args[1]).to.equal(1);
    expect(committed[2].args[1]).to.equal(2);
  });
});
