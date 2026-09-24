// ABOUTME: Exercises the same pre-funding guard called by deploy_crowdfund with real governance contracts.
// ABOUTME: Misconfiguration cases fail while the RevenueLock still has no funds to strand.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployGovernorProxy } from "./helpers/deploy-governor";
import { assertAllocatorMultisig, assertRevenueLockAllocation, assertReservePreFunding, validateReservePlan } from "../scripts/revenue-reserve";

describe("Reserve deployment funding gate", function () {
  async function fixture() {
    const [deployer, a, b, c, treasury, crowdfund, pause] = await ethers.getSigners();
    const allocator = await (await ethers.getContractFactory("ReserveAllocatorIntrospectionMock"))
      .deploy([a.address, b.address, c.address], 2);
    const allocatorAddress = await allocator.getAddress();
    const token = await (await ethers.getContractFactory("ArmadaToken")).deploy(deployer.address, deployer.address);
    const tokenAddress = await token.getAddress();
    const governorProxy = await deployGovernorProxy(tokenAddress, deployer.address, treasury.address);
    const governor = await ethers.getContractAt("ArmadaGovernor", await governorProxy.getAddress());
    const governorAddress = await governor.getAddress();
    const Counter = await ethers.getContractFactory("RevenueCounter");
    const implementation = await Counter.deploy();
    const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await implementation.getAddress(),
      Counter.interface.encodeFunctionData("initialize", [deployer.address]));
    const counter = await ethers.getContractAt("RevenueCounter", await proxy.getAddress());
    const cap = ethers.parseEther("360000");
    const distributor = await (await ethers.getContractFactory("RevenueReserveDistributor"))
      .deploy(tokenAddress, allocatorAddress, cap);
    const distributorAddress = await distributor.getAddress();
    const lock = await (await ethers.getContractFactory("RevenueLock")).deploy(tokenAddress,
      await counter.getAddress(), ethers.parseEther("10000"), [distributorAddress, a.address],
      [cap, ethers.parseEther("2040000")]);
    const lockAddress = await lock.getAddress();
    await distributor.bindRevenueLock(lockAddress);
    const redemption = await (await ethers.getContractFactory("ArmadaRedemption"))
      .deploy(tokenAddress, treasury.address, lockAddress, crowdfund.address);
    // The full suite shares a clock; earlier tests may have advanced it by years.
    const windDownDeadline = (await time.latest()) + 365 * 24 * 60 * 60;
    const windDown = await (await ethers.getContractFactory("ArmadaWindDown")).deploy(tokenAddress,
      treasury.address, governorAddress, await redemption.getAddress(), pause.address,
      await counter.getAddress(), lockAddress, deployer.address, ethers.parseEther("10000"), windDownDeadline);
    const windDownAddress = await windDown.getAddress();
    await lock.setWindDownContract(windDownAddress);
    await counter.setWindDownContract(windDownAddress);
    await token.setWindDownContract(windDownAddress);
    await governor.setWindDownContract(windDownAddress);
    await token.initNoDelegation([treasury.address]);
    await token.initWhitelist([deployer.address, lockAddress, distributorAddress]);
    await token.initAuthorizedDelegators([lockAddress]);
    // Exclusions are left unset so individual tests can exercise omission.
    const plan = { distributorAddress, allocator: allocatorAddress, reserveCap: cap,
      revenueLockAllocation: ethers.parseEther("2400000"),
      armTokenAddress: tokenAddress, revenueLockAddress: lockAddress, governorAddress, windDownAddress };
    const exclude = () => governor.setExcludedAddresses([lockAddress, distributorAddress]);
    return { plan, exclude, token, lock, governor, distributor, a, b, c };
  }

  // WHY: Valid settings must permit the transfer while funds are still recoverable in the deployer's wallet.
  it("passes with the lock unfunded and inactive", async function () {
    const { plan, exclude, token, lock } = await loadFixture(fixture);
    await exclude();
    await assertReservePreFunding(plan);
    expect(await token.balanceOf(plan.revenueLockAddress)).to.equal(0);
    expect(await lock.activated()).to.equal(false);
  });

  // WHY: Other suites advance the shared chain clock beyond the old fixed deadline.
  // Recreate the fixture at that future time, then restore the clock for later tests.
  it("passes after earlier suites advance beyond the former fixed deadline", async function () {
    const snapshot = await takeSnapshot();
    try {
      await time.increaseTo(Math.max(await time.latest(), 2_000_000_000) + 365 * 24 * 60 * 60);
      const { plan, exclude } = await fixture();
      await exclude();
      await assertReservePreFunding(plan);
    } finally {
      await snapshot.restore();
    }
  });

  // WHY: A token-only view cannot detect omission from the governor's quorum exclusions.
  it("rejects missing quorum exclusions", async function () {
    const { plan } = await loadFixture(fixture);
    await expect(assertReservePreFunding(plan)).to.be.rejectedWith("quorum-excluded exactly once");
  });

  // WHY: The Safe fallback must represent circulating entitlement, not another excluded custody balance.
  it("rejects an excluded allocator", async function () {
    const { plan, governor } = await loadFixture(fixture);
    await governor.setExcludedAddresses([plan.revenueLockAddress, plan.distributorAddress, plan.allocator]);
    await expect(assertReservePreFunding(plan)).to.be.rejectedWith("custody address");
  });

  // WHY: A valid distributor can still be the wrong deployment for this funding transaction.
  it("rejects a mismatched cap or allocator", async function () {
    const { plan, exclude, a } = await loadFixture(fixture);
    await exclude();
    await expect(assertReservePreFunding({ ...plan, reserveCap: plan.reserveCap + 10_000n }))
      .to.be.rejectedWith("does not match");
    await expect(assertReservePreFunding({ ...plan, allocator: a.address })).to.be.rejectedWith("does not match");
  });

  // WHY: A later env file can describe a valid plan yet fund more or less than the
  // immutable constructor allocations. Reserve cap validation alone cannot catch it.
  it("rejects total funding drift even when the reserve cap and integration match", async function () {
    const { plan, exclude, token, distributor } = await loadFixture(fixture);
    await exclude();
    expect(await distributor.verifyIntegration()).to.equal(true);
    for (const delta of [1n, -1n]) {
      await expect(assertReservePreFunding({ ...plan,
        revenueLockAllocation: plan.revenueLockAllocation + delta }))
        .to.be.rejectedWith("totalAllocation mismatch");
    }
    expect(await token.balanceOf(plan.revenueLockAddress)).to.equal(0);
  });

  // WHY: activate() only enforces a lower bound; it cannot reject or refund excess
  // ARM. The allocation guard must reject the same overfunding before any transfer.
  it("blocks overfunding that the lock's activation would otherwise accept", async function () {
    const { plan, token, lock } = await loadFixture(fixture);
    const excessFunding = plan.revenueLockAllocation + ethers.parseEther("1");
    await expect(assertRevenueLockAllocation(plan.revenueLockAddress, excessFunding))
      .to.be.rejectedWith("totalAllocation mismatch");
    await token.transfer(plan.revenueLockAddress, excessFunding);
    await lock.activate();
    expect(await lock.activated()).to.equal(true);
    expect(await token.balanceOf(plan.revenueLockAddress)).to.equal(excessFunding);
    expect(await lock.totalAllocation()).to.equal(plan.revenueLockAllocation);
  });

  // WHY: Deployments without a reserve must also reject allocation drift.
  it("checks the immutable allocation without requiring a distributor", async function () {
    const { plan, lock, a } = await loadFixture(fixture);
    const directLock = await (await ethers.getContractFactory("RevenueLock"))
      .deploy(plan.armTokenAddress, await lock.revenueCounter(), ethers.parseEther("10000"),
        [a.address], [plan.revenueLockAllocation]);
    await assertRevenueLockAllocation(await directLock.getAddress(), plan.revenueLockAllocation);
    await expect(assertRevenueLockAllocation(await directLock.getAddress(), plan.revenueLockAllocation + 1n))
      .to.be.rejectedWith("totalAllocation mismatch");
  });

  // WHY: Running a check after funding is too late; the deployment guard must reject this sequencing.
  it("rejects funding that already happened", async function () {
    const { plan, exclude, token } = await loadFixture(fixture);
    await exclude();
    await token.transfer(plan.revenueLockAddress, 1);
    await expect(assertReservePreFunding(plan)).to.be.rejectedWith("unfunded, inactive, unfrozen");
  });

  // WHY: Binding to a different wind-down contract defeats the intended end of assignment authority.
  it("rejects mismatched wind-down wiring", async function () {
    const { plan, exclude, a } = await loadFixture(fixture);
    await exclude();
    await expect(assertReservePreFunding({ ...plan, windDownAddress: a.address }))
      .to.be.rejectedWith("wind-down wiring");
  });

  // WHY: Two-of-three is a deployment commitment even though the distributor authenticates only its address.
  it("rejects an EOA, wrong threshold and duplicate owners", async function () {
    const { a, b, c } = await loadFixture(fixture);
    await expect(assertAllocatorMultisig(a.address)).to.be.rejectedWith("deployed multisig");
    const Mock = await ethers.getContractFactory("ReserveAllocatorIntrospectionMock");
    for (const [owners, threshold] of [[[a.address, b.address, c.address], 1], [[a.address, a.address, c.address], 2]] as const) {
      const mock = await Mock.deploy([...owners], threshold);
      await expect(assertAllocatorMultisig(await mock.getAddress())).to.be.rejectedWith("three distinct owners");
    }
  });

  // WHY: The reserve comes out of the lock's existing allocation, so appending 3% to a full 20% list must fail.
  it("requires direct plus reserve allocations to equal the lock total", async function () {
    const { plan, a } = await loadFixture(fixture);
    const reserve = { allocator: plan.allocator, amount: "360000" };
    const direct = [{ address: a.address, amount: "2040000", label: "direct" }];
    expect(validateReservePlan(direct, ethers.parseEther("2400000"), reserve)).to.equal(plan.reserveCap);
    expect(() => validateReservePlan([{ ...direct[0], amount: "2400000" }], ethers.parseEther("2400000"), reserve))
      .to.throw("plus reserve must equal");
    expect(() => validateReservePlan([...direct, ...direct], ethers.parseEther("4440000"), reserve))
      .to.throw("duplicate");
  });
});
