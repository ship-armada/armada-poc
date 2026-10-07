// ABOUTME: Hardhat integration tests for the Launch Team upgrade gate wired into ArmadaGovernor.execute().
// ABOUTME: Runs on the production timelock role layout so the gate cannot be bypassed by a second proposer.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

const ProposalType = { Standard: 0, Extended: 1 };
const ProposalState = { Pending: 0, Active: 1, Defeated: 2, Succeeded: 3, Queued: 4, Executed: 5, Canceled: 6 };
const Vote = { Against: 0, For: 1, Abstain: 2 };
const ONE_DAY = 86400;
const TOTAL_SUPPLY = ethers.parseUnits("12000000", 18);
// ERC1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const IMPLEMENTATION_SLOT = ethers.toBeHex(BigInt(ethers.id("eip1967.proxy.implementation")) - 1n, 32);

describe("Governance Upgrade Gate", function () {
  let deployer: SignerWithAddress, alice: SignerWithAddress, bob: SignerWithAddress;
  let team: SignerWithAddress, council: SignerWithAddress, outsider: SignerWithAddress;
  let timelock: any, armToken: any, treasury: any, gate: any, governor: any, revenueCounter: any;

  async function implementationOf(proxy: string): Promise<string> {
    const raw = await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT);
    return ethers.getAddress("0x" + raw.slice(26));
  }

  async function newGovernorImpl(gateAddress?: string): Promise<string> {
    const factory = await ethers.getContractFactory("ArmadaGovernor");
    const impl = await factory.deploy(gateAddress ?? await gate.getAddress());
    await impl.waitForDeployment();
    return impl.getAddress();
  }

  // Propose, pass (alice alone meets the Extended quorum), and queue. Returns the proposal id and
  // the action arrays the Launch Team would approve.
  async function passAndQueue(targets: string[], calldatas: string[]) {
    const values = targets.map(() => 0n);
    await governor.connect(alice).propose(ProposalType.Extended, targets, values, calldatas, "gated test");
    const id = await governor.proposalCount();
    await time.increase(2 * ONE_DAY + 1);
    await governor.connect(alice).castVote(id, Vote.For);
    await time.increase(14 * ONE_DAY + 1);
    await governor.queue(id);
    return { id, targets, values, calldatas };
  }

  async function passQueueAndWait(targets: string[], calldatas: string[]) {
    const p = await passAndQueue(targets, calldatas);
    await time.increase(7 * ONE_DAY + 1);
    return p;
  }

  beforeEach(async function () {
    [deployer, alice, bob, team, council, outsider] = await ethers.getSigners();

    const Timelock = await ethers.getContractFactory("TimelockController");
    timelock = await Timelock.deploy(2 * ONE_DAY, [], [], deployer.address);
    const timelockAddr = await timelock.getAddress();
    armToken = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, timelockAddr);
    treasury = await (await ethers.getContractFactory("ArmadaTreasuryGov")).deploy(timelockAddr);
    gate = await (await ethers.getContractFactory("UpgradeGate")).deploy(team.address);
    governor = await deployGovernorProxy(
      await armToken.getAddress(), timelockAddr, await treasury.getAddress(), await gate.getAddress(),
    );
    const governorAddr = await governor.getAddress();

    const RevenueCounter = await ethers.getContractFactory("RevenueCounter");
    const counterImpl = await RevenueCounter.deploy();
    const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(
      await counterImpl.getAddress(), RevenueCounter.interface.encodeFunctionData("initialize", [timelockAddr]),
    );
    revenueCounter = RevenueCounter.attach(await proxy.getAddress());

    await governor.setSecurityCouncil(council.address);

    // Production role layout: governor holds every operational role, nobody holds admin.
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), governorAddr);
    await timelock.grantRole(await timelock.CANCELLER_ROLE(), governorAddr);
    const admin = await timelock.TIMELOCK_ADMIN_ROLE();
    await timelock.revokeRole(admin, timelockAddr);
    await timelock.renounceRole(admin, deployer.address);

    await armToken.initWhitelist([deployer.address, alice.address, bob.address]);
    await armToken.transfer(alice.address, TOTAL_SUPPLY * 40n / 100n);
    await armToken.transfer(bob.address, TOTAL_SUPPLY * 5n / 100n);
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);
    await mine(1);
  });

  // WHY: the governor must expose which gate guards it, so deploy verification and the Launch
  // Team approval tooling can confirm the wiring.
  it("exposes the gate it was constructed with", async function () {
    expect(await governor.upgradeGate()).to.equal(await gate.getAddress());
  });

  // WHY: a governor implementation without a gate would revert on every execute (calls to
  // address(0) fail) — reject it at construction instead of shipping a bricked implementation.
  it("rejects a zero gate at construction", async function () {
    const factory = await ethers.getContractFactory("ArmadaGovernor");
    await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(governor, "Gov_ZeroUpgradeGate");
  });

  // WHY: the core property — governance alone cannot upgrade the governor. Without Launch Team
  // approval the passed proposal cannot execute; with approval it executes normally.
  it("blocks a governor upgrade until the Launch Team approves that proposal", async function () {
    const governorAddr = await governor.getAddress();
    const v2 = await newGovernorImpl();
    const p = await passQueueAndWait([governorAddr], [governor.interface.encodeFunctionData("upgradeTo", [v2])]);

    await expect(governor.execute(p.id))
      .to.be.revertedWithCustomError(gate, "Gate_NotApproved").withArgs(p.id);

    await gate.connect(team).approve(p.id, p.targets, p.values, p.calldatas);
    await governor.execute(p.id);
    expect(await governor.state(p.id)).to.equal(ProposalState.Executed);
    expect(await implementationOf(governorAddr)).to.equal(v2);
  });

  // WHY: replay — re-proposing an earlier approved implementation (a rollback to a version with a
  // known bug) must need a fresh approval; the old proposal's approval does not carry over.
  it("does not let an earlier approval authorize a later rollback proposal", async function () {
    const governorAddr = await governor.getAddress();
    const v2 = await newGovernorImpl();
    const v3 = await newGovernorImpl();
    const upgradeTo = (impl: string) => governor.interface.encodeFunctionData("upgradeTo", [impl]);

    const toV2 = await passQueueAndWait([governorAddr], [upgradeTo(v2)]);
    await gate.connect(team).approve(toV2.id, toV2.targets, toV2.values, toV2.calldatas);
    await governor.execute(toV2.id);

    const toV3 = await passQueueAndWait([governorAddr], [upgradeTo(v3)]);
    await gate.connect(team).approve(toV3.id, toV3.targets, toV3.values, toV3.calldatas);
    await governor.execute(toV3.id);

    const rollback = await passQueueAndWait([governorAddr], [upgradeTo(v2)]);
    await expect(governor.execute(rollback.id))
      .to.be.revertedWithCustomError(gate, "Gate_NotApproved").withArgs(rollback.id);
    expect(await implementationOf(governorAddr)).to.equal(v3);
  });

  // WHY: the team must be able to change its mind during the execution delay.
  it("blocks execution when the approval is revoked after queueing", async function () {
    const governorAddr = await governor.getAddress();
    const p = await passAndQueue(
      [governorAddr], [governor.interface.encodeFunctionData("upgradeTo", [await newGovernorImpl()])],
    );
    await gate.connect(team).approve(p.id, p.targets, p.values, p.calldatas);
    await gate.connect(team).revoke(p.id, p.targets, p.values, p.calldatas);
    await time.increase(7 * ONE_DAY + 1);
    await expect(governor.execute(p.id)).to.be.revertedWithCustomError(gate, "Gate_NotApproved");
  });

  // WHY: RevenueCounter is the second upgrade route; a malicious implementation could fake revenue
  // or brick wind-down. The gate keys on the selector, so any UUPS target is covered.
  it("gates a RevenueCounter upgrade", async function () {
    const counterAddr = await revenueCounter.getAddress();
    const newImpl = await (await ethers.getContractFactory("RevenueCounter")).deploy();
    const p = await passQueueAndWait(
      [counterAddr], [revenueCounter.interface.encodeFunctionData("upgradeTo", [await newImpl.getAddress()])],
    );
    await expect(governor.execute(p.id)).to.be.revertedWithCustomError(gate, "Gate_NotApproved");
    await gate.connect(team).approve(p.id, p.targets, p.values, p.calldatas);
    await governor.execute(p.id);
    expect(await implementationOf(counterAddr)).to.equal(await newImpl.getAddress());
  });

  // WHY: a newly authorized delegator can re-delegate any holder's votes (route 2). Wiring a new
  // RevenueLock cohort needs the Launch Team to confirm the delegator is canonical code.
  it("gates addAuthorizedDelegator", async function () {
    const cohort = outsider.address;
    const p = await passQueueAndWait(
      [await armToken.getAddress()], [armToken.interface.encodeFunctionData("addAuthorizedDelegator", [cohort])],
    );
    await expect(governor.execute(p.id)).to.be.revertedWithCustomError(gate, "Gate_NotApproved");
    await gate.connect(team).approve(p.id, p.targets, p.values, p.calldatas);
    await governor.execute(p.id);
    expect(await armToken.authorizedDelegator(cohort)).to.equal(true);
  });

  // WHY: a vetoed proposal restored by a failed ratification is re-queued under the same id and
  // executes through the same path — it must still need Launch Team approval.
  it("still gates a proposal restored after an overturned veto", async function () {
    const governorAddr = await governor.getAddress();
    const p = await passAndQueue(
      [governorAddr], [governor.interface.encodeFunctionData("upgradeTo", [await newGovernorImpl()])],
    );
    await governor.connect(council).veto(p.id, ethers.id("rationale"));
    const ratificationId = await governor.proposalCount();
    await governor.connect(alice).castVote(ratificationId, Vote.Against);
    await time.increase(7 * ONE_DAY + 1);
    await governor.resolveRatification(ratificationId);
    expect(await governor.state(p.id)).to.equal(ProposalState.Queued);
    await time.increase(2 * ONE_DAY + 1);

    await expect(governor.execute(p.id)).to.be.revertedWithCustomError(gate, "Gate_NotApproved");
    await gate.connect(team).approve(p.id, p.targets, p.values, p.calldatas);
    await governor.execute(p.id);
    expect(await governor.state(p.id)).to.equal(ProposalState.Executed);
  });

  // WHY: ordinary governance must keep working with no Launch Team involvement.
  it("executes proposals without gated actions with no approval", async function () {
    const p = await passQueueAndWait(
      [await governor.getAddress()], [governor.interface.encodeFunctionData("proposalCount")],
    );
    await governor.execute(p.id);
    expect(await governor.state(p.id)).to.equal(ProposalState.Executed);
  });

  // WHY: only the Launch Team's approval counts; anyone else calling approve is rejected.
  it("rejects approvals from anyone but the Launch Team", async function () {
    const governorAddr = await governor.getAddress();
    const p = await passQueueAndWait(
      [governorAddr], [governor.interface.encodeFunctionData("upgradeTo", [await newGovernorImpl()])],
    );
    for (const signer of [deployer, alice, council]) {
      await expect(gate.connect(signer).approve(p.id, p.targets, p.values, p.calldatas))
        .to.be.revertedWithCustomError(gate, "Gate_NotLaunchTeam");
    }
    const timelockAddr = await timelock.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
    await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
    await expect(gate.connect(await ethers.getSigner(timelockAddr)).approve(p.id, p.targets, p.values, p.calldatas))
      .to.be.revertedWithCustomError(gate, "Gate_NotLaunchTeam");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
  });
});
