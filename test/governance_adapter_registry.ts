// ABOUTME: Hardhat integration tests for the adapter registry in ArmadaGovernor.
// ABOUTME: Covers full governance proposal lifecycle for authorizing, deauthorizing, and fully removing adapters.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, mine } from "@nomicfoundation/hardhat-network-helpers";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

// Proposal types (must match IArmadaGovernance.sol enum order)
const ProposalType = { Standard: 0, Extended: 1, VetoRatification: 2, Steward: 3 };
// Proposal states
const ProposalState = {
  Pending: 0, Active: 1, Defeated: 2, Succeeded: 3,
  Queued: 4, Executed: 5, Canceled: 6,
};
// Vote support values
const Vote = { Against: 0, For: 1, Abstain: 2 };

// Time constants
const ONE_DAY = 86400;
const TWO_DAYS = 2 * ONE_DAY;
const SEVEN_DAYS = 7 * ONE_DAY;

describe("Governance Adapter Registry", function () {
  // Contracts
  let armToken: any;
  let timelockController: any;
  let governor: any;
  let treasury: any;

  // Signers
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;

  // Constants
  const ARM_DECIMALS = 18;
  const TOTAL_SUPPLY = ethers.parseUnits("12000000", ARM_DECIMALS);
  const TREASURY_AMOUNT = TOTAL_SUPPLY * 50n / 100n;
  const ALICE_AMOUNT = TOTAL_SUPPLY * 25n / 100n;
  const BOB_AMOUNT = TOTAL_SUPPLY * 15n / 100n;

  // Adapter addresses (just arbitrary addresses for testing)
  let adapterAddr: string;

  async function mineBlock() {
    await mine(1);
  }

  async function asTimelock(): Promise<SignerWithAddress> {
    const timelockAddr = await timelockController.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
    await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
    return await ethers.getSigner(timelockAddr) as unknown as SignerWithAddress;
  }

  async function stopImpersonatingTimelock() {
    const timelockAddr = await timelockController.getAddress();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
  }

  /// Create a Standard proposal, vote it through, queue, wait execution delay, then execute.
  /// Returns the proposalId.
  async function proposeVoteQueueExecute(
    targets: string[],
    calldatas: string[],
    description: string,
  ): Promise<number> {
    const values = targets.map(() => 0n);

    await governor.connect(alice).propose(
      ProposalType.Standard, targets, values, calldatas, description
    );
    const proposalId = Number(await governor.proposalCount());

    // Advance past voting delay (2 days)
    await time.increase(TWO_DAYS + 1);

    // Vote FOR with alice and bob (40% combined, exceeds 20% quorum)
    await governor.connect(alice).castVote(proposalId, Vote.For);
    await governor.connect(bob).castVote(proposalId, Vote.For);

    // Advance past voting period (7 days for Standard)
    await time.increase(SEVEN_DAYS + 1);
    expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

    // Queue
    await governor.queue(proposalId);
    expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

    // Advance past execution delay (2 days for Standard)
    await time.increase(TWO_DAYS + 1);

    // Execute
    await governor.execute(proposalId);
    expect(await governor.state(proposalId)).to.equal(ProposalState.Executed);

    return proposalId;
  }

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();

    adapterAddr = carol.address; // Use carol's address as a stand-in adapter

    // 1. Deploy TimelockController
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelockController = await TimelockController.deploy(
      TWO_DAYS, [], [], deployer.address
    );
    await timelockController.waitForDeployment();
    const timelockAddr = await timelockController.getAddress();

    // 2. Deploy ARM token
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();

    // 3. Deploy Treasury
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr);
    await treasury.waitForDeployment();

    // 4. Deploy Governor
    governor = await deployGovernorProxy(
      await armToken.getAddress(),
      timelockAddr,
      await treasury.getAddress(),
    );

    // 5. Configure timelock roles
    const govAddr = await governor.getAddress();
    await timelockController.grantRole(await timelockController.PROPOSER_ROLE(), govAddr);
    await timelockController.grantRole(await timelockController.EXECUTOR_ROLE(), govAddr);
    await timelockController.grantRole(await timelockController.CANCELLER_ROLE(), govAddr);

    // 6. Renounce deployer admin role on timelock
    await timelockController.renounceRole(
      await timelockController.TIMELOCK_ADMIN_ROLE(), deployer.address
    );

    // 7. Configure ARM token
    await armToken.setNoDelegation(await treasury.getAddress());
    await armToken.initWhitelist([
      deployer.address,
      await treasury.getAddress(),
      alice.address,
      bob.address,
      govAddr,
    ]);

    // 8. Distribute ARM tokens
    await armToken.transfer(await treasury.getAddress(), TREASURY_AMOUNT);
    await armToken.transfer(alice.address, ALICE_AMOUNT);
    await armToken.transfer(bob.address, BOB_AMOUNT);

    // 9. Delegate tokens for voting power
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    await mineBlock();
  });

  // ======== Authorize via Governance ========

  describe("Authorize Adapter", function () {
    it("should authorize adapter via governance proposal", async function () {
      const govAddr = await governor.getAddress();
      const calldata = governor.interface.encodeFunctionData("authorizeAdapter", [adapterAddr]);

      await proposeVoteQueueExecute([govAddr], [calldata], "Authorize adapter");

      expect(await governor.authorizedAdapters(adapterAddr)).to.equal(true);
      expect(await governor.withdrawOnlyAdapters(adapterAddr)).to.equal(false);
    });

    it("should classify authorizeAdapter as Standard (not Extended)", async function () {
      const govAddr = await governor.getAddress();
      const calldata = governor.interface.encodeFunctionData("authorizeAdapter", [adapterAddr]);

      await governor.connect(alice).propose(
        ProposalType.Standard, [govAddr], [0n], [calldata], "Authorize adapter"
      );
      const proposalId = Number(await governor.proposalCount());
      const proposal = await governor.getProposal(proposalId);

      // ProposalType.Standard = 0
      expect(proposal.proposalType).to.equal(ProposalType.Standard);
    });
  });

  // ======== Deauthorize via Governance ========

  describe("Deauthorize Adapter", function () {
    it("should deauthorize adapter to withdraw-only via governance", async function () {
      const govAddr = await governor.getAddress();

      // First: authorize
      const authCalldata = governor.interface.encodeFunctionData("authorizeAdapter", [adapterAddr]);
      await proposeVoteQueueExecute([govAddr], [authCalldata], "Authorize adapter");
      expect(await governor.authorizedAdapters(adapterAddr)).to.equal(true);

      // Then: deauthorize
      const deauthCalldata = governor.interface.encodeFunctionData("deauthorizeAdapter", [adapterAddr]);
      await proposeVoteQueueExecute([govAddr], [deauthCalldata], "Deauthorize adapter");

      expect(await governor.authorizedAdapters(adapterAddr)).to.equal(false);
      expect(await governor.withdrawOnlyAdapters(adapterAddr)).to.equal(true);
    });
  });

  // ======== Full Deauthorize via Governance ========

  describe("Full Deauthorize Adapter", function () {
    it("should fully remove adapter after withdraw-only period via governance", async function () {
      const govAddr = await governor.getAddress();

      // Authorize
      const authCalldata = governor.interface.encodeFunctionData("authorizeAdapter", [adapterAddr]);
      await proposeVoteQueueExecute([govAddr], [authCalldata], "Authorize adapter");

      // Deauthorize (withdraw-only)
      const deauthCalldata = governor.interface.encodeFunctionData("deauthorizeAdapter", [adapterAddr]);
      await proposeVoteQueueExecute([govAddr], [deauthCalldata], "Deauthorize adapter");

      // Full deauthorize
      const fullDeauthCalldata = governor.interface.encodeFunctionData("fullDeauthorizeAdapter", [adapterAddr]);
      await proposeVoteQueueExecute([govAddr], [fullDeauthCalldata], "Fully remove adapter");

      expect(await governor.authorizedAdapters(adapterAddr)).to.equal(false);
      expect(await governor.withdrawOnlyAdapters(adapterAddr)).to.equal(false);
    });
  });

  // ======== Access Control (direct calls without timelock) ========

  describe("Access Control", function () {
    it("should revert authorizeAdapter when called directly (not via timelock)", async function () {
      await expect(
        governor.connect(alice).authorizeAdapter(adapterAddr)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });

    it("should revert deauthorizeAdapter when called directly", async function () {
      await expect(
        governor.connect(alice).deauthorizeAdapter(adapterAddr)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });

    it("should revert fullDeauthorizeAdapter when called directly", async function () {
      await expect(
        governor.connect(alice).fullDeauthorizeAdapter(adapterAddr)
      ).to.be.revertedWith("ArmadaGovernor: not timelock");
    });
  });
});
