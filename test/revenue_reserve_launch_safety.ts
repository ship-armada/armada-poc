// ABOUTME: Reproduces permissionless activation races with real contracts and explicit nonces.
// ABOUTME: Checks launch continuation and real timelock admin/delay verification.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { ensureRevenueLockActivated } from "../scripts/revenue-reserve";
import { timelockBootstrapChecks } from "../scripts/verify-timelock";

describe("Reserve launch safety", function () {
  async function fixture(funded = true) {
    const [deployer, outsider] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
    const counter = await (await ethers.getContractFactory("RevenueCounter")).deploy();
    const lock = await (await ethers.getContractFactory("RevenueLock")).deploy(await token.getAddress(),
      await counter.getAddress(), ethers.parseEther("10000"), [outsider.address], [10_000n]);
    await token.initWhitelist([deployer.address]);
    if (funded) await token.transfer(await lock.getAddress(), 10_000n);
    const timelock = await (await ethers.getContractFactory("TimelockController"))
      .deploy(0, [deployer.address], [deployer.address], deployer.address);
    let next = await deployer.getNonce();
    const nm = { override: () => ({ nonce: next++ }) };
    return { deployer, outsider, lock, timelock, nm, next: () => next };
  }

  // WHY: An early outsider activation must neither abort continuation nor reserve an unused nonce.
  it("skips an already activated lock without consuming a nonce", async function () {
    const { lock, outsider, nm, next } = await fixture();
    await lock.connect(outsider).activate();
    const before = next();
    await ensureRevenueLockActivated(lock, nm);
    expect(next()).to.equal(before);
  });

  // WHY: The initial view and gas estimate are separate RPC calls; the race can occur between them.
  it("handles activation between preflight and estimation without a nonce gap", async function () {
    const { lock, outsider, nm, next } = await fixture();
    const before = next();
    const activate = Object.assign((overrides: { gasLimit: bigint; nonce?: number }) => lock.activate(overrides), {
      estimateGas: async () => {
        await lock.connect(outsider).activate();
        return lock.activate.estimateGas();
      },
    });
    await ensureRevenueLockActivated({ activated: () => lock.activated(), activate }, nm);
    expect(next()).to.equal(before);
  });

  // WHY: A raced transaction can revert after estimation. The consumed nonce must still allow
  // production delay and all bootstrap-role revocations to execute, as in crowdfund deployment.
  it("finishes timelock hardening after an activation transaction loses the race", async function () {
    const { lock, outsider, deployer, timelock, nm, next } = await fixture();
    const before = next();
    const activate = Object.assign(async (overrides: { gasLimit: bigint; nonce?: number }) => {
      await network.provider.send("evm_setAutomine", [false]);
      const winning = await lock.connect(outsider).activate({ gasLimit: 100_000n, gasPrice: 2_000_000_000n });
      const losing = await lock.activate({ ...overrides, gasPrice: 2_000_000_000n });
      await network.provider.send("evm_mine");
      await winning.wait();
      return losing;
    }, { estimateGas: () => lock.activate.estimateGas() });
    try {
      await ensureRevenueLockActivated({ activated: () => lock.activated(), activate }, nm);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    expect(next()).to.equal(before + 1);
    const address = await timelock.getAddress();
    const data = timelock.interface.encodeFunctionData("updateDelay", [172800]);
    await (await timelock.schedule(address, 0, data, ethers.ZeroHash, ethers.ZeroHash, 0, nm.override())).wait();
    await (await timelock.execute(address, 0, data, ethers.ZeroHash, ethers.ZeroHash, nm.override())).wait();
    for (const role of [await timelock.PROPOSER_ROLE(), await timelock.EXECUTOR_ROLE(),
      await timelock.CANCELLER_ROLE(), await timelock.TIMELOCK_ADMIN_ROLE()]) {
      await (await timelock.renounceRole(role, deployer.address, nm.override())).wait();
    }
    expect((await timelockBootstrapChecks(address, deployer.address, 172800n))
      .every(check => check.status === "PASS")).to.equal(true);
    expect(await deployer.getNonce()).to.equal(next());
  });

  // WHY: Actual underfunding must still stop deployment; the race handler cannot turn errors into success.
  it("propagates underfunding without reserving a nonce", async function () {
    const { lock, nm, next } = await fixture(false);
    const before = next();
    await expect(ensureRevenueLockActivated(lock, nm)).to.be.rejectedWith("underfunded");
    expect(next()).to.equal(before);
  });

  // WHY: A send failure may have an unknown broadcast state; never continue and guess its nonce.
  it("propagates an ambiguous send failure even if an outsider subsequently activates", async function () {
    const { lock, outsider, nm } = await fixture();
    const activate = Object.assign(async (_overrides: { gasLimit: bigint; nonce?: number }): Promise<never> => {
      await lock.connect(outsider).activate();
      throw new Error("RPC send unavailable");
    }, { estimateGas: () => lock.activate.estimateGas() });
    await expect(ensureRevenueLockActivated({ activated: () => lock.activated(), activate }, nm))
      .to.be.rejectedWith("RPC send unavailable");
  });

  // WHY: OZ's DEFAULT_ADMIN_ROLE is absent even during bootstrap; the actual admin role must fail launch checks.
  it("detects retained timelock admin, operational roles, and zero production delay", async function () {
    const { timelock, deployer } = await fixture();
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
    const strict = await timelockBootstrapChecks(await timelock.getAddress(), deployer.address, 172800n);
    expect(strict).to.have.length(5);
    expect(strict.every(check => check.status === "FAIL")).to.equal(true);
    const partial = await timelockBootstrapChecks(await timelock.getAddress(), deployer.address);
    expect(partial.every(check => check.status === "WARN")).to.equal(true);
  });
});
