// ABOUTME: Exercises the same pre-funding guard called by deploy_crowdfund with real governance contracts.
// ABOUTME: Misconfiguration cases fail while the RevenueLock still has no funds to strand.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, takeSnapshot, time, mine, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { deployGovernorProxy } from "./helpers/deploy-governor";
import { assertAllocatorMultisig, assertRevenueLockAllocation, assertRevenueLockSchedule, assertReservePreFunding, validateReservePlan, revenueLockSchedule, type RevenueLockConstructorArgs } from "../scripts/revenue-reserve";
import { buildRevenueLockVerificationTasks } from "../scripts/verify_sepolia";

describe("Reserve deployment funding gate", function () {
  async function fixture(blockAllocatorDelegation = false) {
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
    const directBeneficiaries = [{ address: a.address, amount: "1040000", label: "a" },
      { address: b.address, amount: "1000000", label: "b" }];
    const schedule = revenueLockSchedule(directBeneficiaries, { address: distributorAddress, cap });
    const lock = await (await ethers.getContractFactory("RevenueLock")).deploy(tokenAddress,
      await counter.getAddress(), ethers.parseEther("10000"), schedule.addresses, schedule.amounts);
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
    await token.initNoDelegation([treasury.address, ...(blockAllocatorDelegation ? [allocatorAddress] : [])]);
    await token.initWhitelist([deployer.address, lockAddress, distributorAddress]);
    await token.initAuthorizedDelegators([lockAddress]);
    // Exclusions are left unset so individual tests can exercise omission.
    const plan = { distributorAddress, allocator: allocatorAddress, reserveCap: cap,
      revenueLockAllocation: ethers.parseEther("2400000"),
      directBeneficiaries,
      armTokenAddress: tokenAddress, revenueLockAddress: lockAddress, governorAddress, windDownAddress };
    const exclude = () => governor.setExcludedAddresses([lockAddress, distributorAddress]);
    const constructorArgs: RevenueLockConstructorArgs = [tokenAddress, await counter.getAddress(),
      ethers.parseEther("10000").toString(), schedule.addresses, schedule.amounts.map(String)];
    return { plan, exclude, token, lock, governor, distributor, a, b, c, counter, constructorArgs };
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
      .to.be.rejectedWith("beneficiary allocation mismatch");
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

  // WHY: Equal totals do not prove the immutable schedule matches the latest beneficiary file.
  it("rejects a substituted recipient while preserving count and total", async function () {
    const { plan, exclude, token, c } = await loadFixture(fixture);
    await exclude();
    const directBeneficiaries = plan.directBeneficiaries.map((b, i) => i === 0 ? { ...b, address: c.address } : b);
    await expect(assertReservePreFunding({ ...plan, directBeneficiaries }))
      .to.be.rejectedWith("beneficiary allocation mismatch");
    expect(await token.balanceOf(plan.revenueLockAddress)).to.equal(0);
  });

  // WHY: Swapping amounts between existing recipients also preserves the total and count.
  it("rejects reassigned amounts between the same recipients", async function () {
    const { plan, exclude } = await loadFixture(fixture);
    await exclude();
    const directBeneficiaries = plan.directBeneficiaries.map((b, i) =>
      ({ ...b, amount: plan.directBeneficiaries[1 - i].amount }));
    await expect(assertReservePreFunding({ ...plan, directBeneficiaries }))
      .to.be.rejectedWith("beneficiary allocation mismatch");
  });

  // WHY: Count and uniqueness prevent duplicate or omitted entries masking unapproved recipients.
  it("rejects missing, extra and duplicate schedule entries", async function () {
    const { plan, exclude, c } = await loadFixture(fixture);
    await exclude();
    for (const directBeneficiaries of [plan.directBeneficiaries.slice(0, 1),
      [...plan.directBeneficiaries, { address: c.address, amount: "1", label: "extra" }]]) {
      await expect(assertReservePreFunding({ ...plan, directBeneficiaries }))
        .to.be.rejectedWith("beneficiary count mismatch");
    }
    await expect(assertReservePreFunding({ ...plan,
      directBeneficiaries: [plan.directBeneficiaries[0], plan.directBeneficiaries[0]] }))
      .to.be.rejectedWith("duplicate RevenueLock schedule");
  });

  // WHY: Funding depends on address/amount membership, not JSON order or address casing.
  it("accepts reordered unchanged allocations", async function () {
    const { plan, exclude } = await loadFixture(fixture);
    await exclude();
    await assertReservePreFunding({ ...plan, directBeneficiaries:
      [...plan.directBeneficiaries].reverse().map(b => ({ ...b, address: b.address.toLowerCase() })) });
  });

  // WHY: Explorer arguments must recreate actual deployment input for both reserve contracts.
  it("reconstructs exact lock and distributor deployment inputs", async function () {
    const { plan, lock, distributor, constructorArgs } = await loadFixture(fixture);
    const tasks = await buildRevenueLockVerificationTasks({ armToken: plan.armTokenAddress,
      revenueCounter: await lock.revenueCounter(), revenueLock: plan.revenueLockAddress,
      revenueReserveDistributor: plan.distributorAddress }, plan.directBeneficiaries, constructorArgs);
    expect(tasks.map(t => t.name)).to.deep.equal(["RevenueReserveDistributor", "RevenueLock"]);
    for (const task of tasks) {
      const factory = await ethers.getContractFactory(task.name);
      const reconstructed = await factory.getDeployTransaction(...task.constructorArguments);
      const deployed = task.name === "RevenueLock" ? lock : distributor;
      expect(reconstructed.data).to.equal(deployed.deploymentTransaction()!.data);
    }
  });

  // WHY: The optional reserve must not change verification or gate behavior for a direct-only lock.
  it("verifies direct-only constructor arguments and rejects direct-only recipient drift", async function () {
    const { plan, lock, c } = await loadFixture(fixture);
    const factory = await ethers.getContractFactory("RevenueLock");
    const schedule = revenueLockSchedule(plan.directBeneficiaries);
    const directLock = await factory.deploy(plan.armTokenAddress, await lock.revenueCounter(),
      ethers.parseEther("10000"), schedule.addresses, schedule.amounts);
    const tasks = await buildRevenueLockVerificationTasks({ armToken: plan.armTokenAddress,
      revenueCounter: await lock.revenueCounter(), revenueLock: await directLock.getAddress() }, plan.directBeneficiaries,
      [plan.armTokenAddress, await lock.revenueCounter(), ethers.parseEther("10000").toString(),
        schedule.addresses, schedule.amounts.map(String)]);
    expect(tasks).to.have.length(1);
    const args = tasks[0].constructorArguments as [string, string, bigint, string[], bigint[]];
    expect((await factory.getDeployTransaction(...args)).data)
      .to.equal(directLock.deploymentTransaction()!.data);
    await expect(assertRevenueLockSchedule(await directLock.getAddress(),
      plan.directBeneficiaries.map((b, i) => i === 0 ? { ...b, address: c.address } : b)))
      .to.be.rejectedWith("beneficiary allocation mismatch");
  });

  // WHY: The allocator fallback must be able to delegate its voting-eligible ARM.
  it("rejects a noDelegation allocator before funding", async function () {
    const { plan, exclude, token } = await fixture(true);
    await exclude();
    await expect(assertReservePreFunding(plan)).to.be.rejectedWith("noDelegation address");
    expect(await token.balanceOf(plan.revenueLockAddress)).to.equal(0);
  });

  // WHY: Set-equivalent config order must not change the original constructor encoding.
  it("preserves constructor input after current beneficiaries are reordered", async function () {
    const { plan, lock, constructorArgs } = await loadFixture(fixture);
    const contracts = { armToken: plan.armTokenAddress, revenueCounter: await lock.revenueCounter(),
      revenueLock: plan.revenueLockAddress, revenueReserveDistributor: plan.distributorAddress };
    const tasks = await buildRevenueLockVerificationTasks(contracts,
      [...plan.directBeneficiaries].reverse(), JSON.parse(JSON.stringify(constructorArgs)));
    const args = tasks.find(t => t.name === "RevenueLock")!.constructorArguments as RevenueLockConstructorArgs;
    expect((await (await ethers.getContractFactory("RevenueLock")).getDeployTransaction(...args)).data)
      .to.equal(lock.deploymentTransaction()!.data);
    await expect(buildRevenueLockVerificationTasks(contracts, plan.directBeneficiaries))
      .to.be.rejectedWith("Original RevenueLock constructor arguments missing");
    const badArgs: RevenueLockConstructorArgs = [...constructorArgs];
    badArgs[2] = "1";
    await expect(buildRevenueLockVerificationTasks(contracts, plan.directBeneficiaries, badArgs))
      .to.be.rejectedWith("do not match deployed lock");
  });

  // WHY: Sponsored payouts change future eligible supply, never an existing proposal's
  // stored denominator. Exercise the real governor at both 20% and 30% quorum.
  it("pins sponsored-payout quorum effects with the real governor", async function () {
    const { plan, exclude, token, lock, governor, distributor, counter, a, c } = await fixture();
    await exclude();
    await assertReservePreFunding(plan);
    const circulating = ethers.parseEther("1200000");
    await token.transfer(plan.revenueLockAddress, plan.revenueLockAllocation);
    await token.transfer(a.address, circulating);
    const [deployer] = await ethers.getSigners();
    await token.transfer(await governor.treasuryAddress(), await token.balanceOf(deployer.address));
    await token.connect(a).delegate(a.address);
    await lock.activate();
    await setBalance(plan.allocator, ethers.parseEther("1"));
    const allocator = await ethers.getImpersonatedSigner(plan.allocator);
    try {
      await distributor.connect(allocator).assign(c.address, plan.reserveCap);
    } finally {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [plan.allocator]);
    }
    await counter.attestRevenue(ethers.parseEther("1000000"));
    await time.increase(101 * 86400);
    await mine();
    const propose = async (extended: boolean) => {
      await governor.connect(a).propose(extended ? 1 : 4,
        extended ? [plan.armTokenAddress] : [], extended ? [0] : [],
        extended ? [token.interface.encodeFunctionData("setTransferable", [true])] : [], "Reserve quorum regression");
      return governor.proposalCount();
    };
    const oldIds = [await propose(false), await propose(true)];
    const bps = [2000n, 3000n];
    await distributor.distribute();
    expect(await token.balanceOf(c.address)).to.equal(plan.reserveCap);
    expect(await token.getVotes(c.address)).to.equal(0);
    expect(await token.getVotes(plan.distributorAddress)).to.equal(0);
    for (let i = 0; i < oldIds.length; i++) {
      const old = await governor.getProposal(oldIds[i]);
      expect(old.snapshotEligibleSupply).to.equal(circulating);
      expect(await governor.quorum(oldIds[i])).to.equal(circulating * bps[i] / 10000n);
      const newId = await propose(i === 1);
      const current = await governor.getProposal(newId);
      expect(current.snapshotEligibleSupply).to.equal(circulating + plan.reserveCap);
      expect(await governor.quorum(newId) - await governor.quorum(oldIds[i]))
        .to.equal(plan.reserveCap * bps[i] / 10000n);
      expect(await token.getPastVotes(c.address, current.snapshotBlock)).to.equal(0);
      expect(await token.getPastVotes(plan.distributorAddress, current.snapshotBlock)).to.equal(0);
    }
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

// WHY: Legacy Sepolia verification must retain the original ordered constructor input, not rebuild it from mutable configuration.
describe("Legacy Sepolia RevenueLock provenance", function () {
  it("reconstructs the recorded creation transaction input", async function () {
    const manifest = require("../deployments/governance-hub-sepolia.json");
    const factory = await ethers.getContractFactory("RevenueLock");
    const input = (await factory.getDeployTransaction(...manifest.revenueLockConstructorArgs)).data;
    // Independently recovered from Sepolia transaction 0x681abad1026db36d1b7b336323cf3f0243d35b15b4d8589802dcfd7bc812e8ac.
    expect(ethers.keccak256(input)).to.equal("0x1687427a8a14e34a735e1e282b0cbcf793aa9e20f8ab7faa1e282f2602bb5b5b");
    expect(ethers.getCreateAddress({ from: manifest.deployer, nonce: 1264 }))
      .to.equal(manifest.contracts.revenueLock);
    expect(manifest.revenueLockDeploymentTransaction).to.equal("0x681abad1026db36d1b7b336323cf3f0243d35b15b4d8589802dcfd7bc812e8ac");
  });
});
