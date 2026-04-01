// ABOUTME: Hardhat tests for ArmadaGovernor UUPS upgradeability.
// ABOUTME: Covers upgrade authorization, state persistence, re-init prevention, and extended classification.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployGovernorProxy } from "./helpers/deploy-governor";

describe("Governance UUPS Upgrade", function () {
  let deployer: any, alice: any, bob: any, attacker: any;
  let armToken: any, timelock: any, treasury: any, governor: any;
  let linkedGovernorFactory: any;

  const TOTAL_SUPPLY = ethers.parseUnits("12000000", 18);
  const TWO_DAYS = 2 * 24 * 60 * 60;

  beforeEach(async function () {
    [deployer, alice, bob, attacker] = await ethers.getSigners();

    // Deploy timelock
    const TimelockController = await ethers.getContractFactory("TimelockController");
    timelock = await TimelockController.deploy(TWO_DAYS, [], [], deployer.address);
    await timelock.waitForDeployment();
    const timelockAddr = await timelock.getAddress();

    // Deploy ARM token
    const ArmadaToken = await ethers.getContractFactory("ArmadaToken");
    armToken = await ArmadaToken.deploy(deployer.address, timelockAddr);
    await armToken.waitForDeployment();
    const armTokenAddr = await armToken.getAddress();

    // Deploy treasury
    const ArmadaTreasuryGov = await ethers.getContractFactory("ArmadaTreasuryGov");
    treasury = await ArmadaTreasuryGov.deploy(timelockAddr);
    await treasury.waitForDeployment();
    const treasuryAddr = await treasury.getAddress();

    // Deploy governor behind UUPS proxy
    governor = await deployGovernorProxy(
      armTokenAddr, timelockAddr, treasuryAddr,
    );

    // Grant timelock roles
    const governorAddr = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), governorAddr);

    // Grant deployer proposer/executor roles for direct timelock operations in tests
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), deployer.address);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), deployer.address);

    // Setup tokens
    const whitelist = [deployer.address, alice.address, bob.address, treasuryAddr];
    await armToken.initWhitelist(whitelist);
    await armToken.transfer(alice.address, TOTAL_SUPPLY * 40n / 100n);
    await armToken.transfer(bob.address, TOTAL_SUPPLY * 20n / 100n);

    // Delegate
    await armToken.connect(alice).delegate(alice.address);
    await armToken.connect(bob).delegate(bob.address);

    // Create linked factory for deploying new governor implementations
    const GovernorStringLib = await ethers.getContractFactory("GovernorStringLib");
    const lib = await GovernorStringLib.deploy();
    await lib.waitForDeployment();
    linkedGovernorFactory = await ethers.getContractFactory("ArmadaGovernor", {
      libraries: { GovernorStringLib: await lib.getAddress() },
    });
  });

  describe("Upgrade Authorization", function () {
    it("upgrade via timelock succeeds", async function () {
      const v2Impl = await linkedGovernorFactory.deploy();
      await v2Impl.waitForDeployment();

      // Execute upgrade via timelock
      const upgradeCalldata = governor.interface.encodeFunctionData(
        "upgradeTo", [await v2Impl.getAddress()]
      );
      const governorAddr = await governor.getAddress();
      await timelock.schedule(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-v2"), TWO_DAYS
      );
      await time.increase(TWO_DAYS + 1);
      await timelock.execute(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-v2")
      );

      // Governor still works — read state through proxy
      expect(await governor.treasuryAddress()).to.equal(await treasury.getAddress());
    });

    it("upgrade from non-timelock reverts", async function () {
      const v2Impl = await linkedGovernorFactory.deploy();
      await v2Impl.waitForDeployment();

      await expect(
        governor.connect(attacker).upgradeTo(await v2Impl.getAddress())
      ).to.be.revertedWithCustomError(governor, "Gov_NotTimelock");
    });

    it("upgrade from deployer reverts", async function () {
      const v2Impl = await linkedGovernorFactory.deploy();
      await v2Impl.waitForDeployment();

      await expect(
        governor.connect(deployer).upgradeTo(await v2Impl.getAddress())
      ).to.be.revertedWithCustomError(governor, "Gov_NotTimelock");
    });
  });

  describe("State Persistence Across Upgrade", function () {
    it("core state persists after upgrade", async function () {
      // Record pre-upgrade state
      const armTokenAddr = await governor.armToken();
      const timelockAddr = await governor.timelock();
      const treasuryAddr = await governor.treasuryAddress();
      const deployerAddr = await governor.deployer();

      // Deploy V2 and upgrade via timelock
      const v2Impl = await linkedGovernorFactory.deploy();
      await v2Impl.waitForDeployment();

      const upgradeCalldata = governor.interface.encodeFunctionData(
        "upgradeTo", [await v2Impl.getAddress()]
      );
      const governorAddr = await governor.getAddress();
      await timelock.schedule(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-state"), TWO_DAYS
      );
      await time.increase(TWO_DAYS + 1);
      await timelock.execute(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-state")
      );

      // Verify state persists
      expect(await governor.armToken()).to.equal(armTokenAddr);
      expect(await governor.timelock()).to.equal(timelockAddr);
      expect(await governor.treasuryAddress()).to.equal(treasuryAddr);
      expect(await governor.deployer()).to.equal(deployerAddr);
    });

    it("proposal type params persist after upgrade", async function () {
      const [delay, period, execDelay, quorum] =
        await governor.proposalTypeParams(0); // Standard
      expect(delay).to.equal(TWO_DAYS);
      expect(period).to.equal(7 * 24 * 60 * 60);
      expect(execDelay).to.equal(TWO_DAYS);
      expect(quorum).to.equal(2000);

      // Upgrade
      const v2Impl = await linkedGovernorFactory.deploy();
      await v2Impl.waitForDeployment();

      const upgradeCalldata = governor.interface.encodeFunctionData(
        "upgradeTo", [await v2Impl.getAddress()]
      );
      const governorAddr = await governor.getAddress();
      await timelock.schedule(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-params"), TWO_DAYS
      );
      await time.increase(TWO_DAYS + 1);
      await timelock.execute(
        governorAddr, 0, upgradeCalldata,
        ethers.ZeroHash, ethers.id("upgrade-params")
      );

      // Verify params persist
      const [d2, p2, e2, q2] = await governor.proposalTypeParams(0);
      expect(d2).to.equal(TWO_DAYS);
      expect(p2).to.equal(7 * 24 * 60 * 60);
      expect(e2).to.equal(TWO_DAYS);
      expect(q2).to.equal(2000);
    });
  });

  describe("Initialization Guards", function () {
    it("cannot re-initialize proxy", async function () {
      await expect(
        governor.initialize(
          await armToken.getAddress(),
          await timelock.getAddress(),
          await treasury.getAddress(),
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    it("implementation cannot be initialized directly", async function () {
      const impl = await linkedGovernorFactory.deploy();
      await impl.waitForDeployment();

      await expect(
        impl.initialize(
          await armToken.getAddress(),
          await timelock.getAddress(),
          await treasury.getAddress(),
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });

  describe("Extended Classification for Upgrades", function () {
    it("upgradeTo selector is registered as extended", async function () {
      const selector = ethers.id("upgradeTo(address)").slice(0, 10);
      expect(await governor.extendedSelectors(selector)).to.be.true;
    });

    it("upgradeToAndCall selector is registered as extended", async function () {
      const selector = ethers.id("upgradeToAndCall(address,bytes)").slice(0, 10);
      expect(await governor.extendedSelectors(selector)).to.be.true;
    });
  });
});
