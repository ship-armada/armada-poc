// ABOUTME: Validates reserve allocation plans and gates irreversible RevenueLock funding.
// ABOUTME: Shared read-only funding checks and race-safe permissionless activation.
import { ethers } from "hardhat";
import type { ContractTransactionResponse } from "ethers";
import type { NonceManager } from "./deploy-utils";
import type { RevenueLockBeneficiary } from "../config/networks";
import { rejectAnvilAddresses } from "./deploy-utils";

export type RevenueReserveConfig = { allocator: string; amount: string };

/** Constructor order is shared by deployment and explorer verification. */
export function revenueLockSchedule(direct: RevenueLockBeneficiary[], reserve?: { address: string; cap: bigint }) {
  const addresses = direct.map(b => ethers.getAddress(b.address));
  const amounts = direct.map(b => ethers.parseUnits(b.amount, 18));
  if (reserve) {
    addresses.push(ethers.getAddress(reserve.address));
    amounts.push(reserve.cap);
  }
  if (new Set(addresses).size !== addresses.length || addresses.includes(ethers.ZeroAddress) ||
      amounts.some(amount => amount <= 0n)) throw new Error("Invalid or duplicate RevenueLock schedule");
  return { addresses, amounts };
}

/** Count plus every unique allocation rules out extra, missing or replaced recipients. */
export async function assertRevenueLockSchedule(address: string, direct: RevenueLockBeneficiary[],
  reserve?: { address: string; cap: bigint }): Promise<void> {
  const { addresses, amounts } = revenueLockSchedule(direct, reserve);
  const lock = await ethers.getContractAt("RevenueLock", address);
  if (await lock.beneficiaryCount() !== BigInt(addresses.length)) {
    throw new Error("RevenueLock beneficiary count mismatch");
  }
  for (let i = 0; i < addresses.length; i++) {
    if (await lock.allocation(addresses[i]) !== amounts[i]) {
      throw new Error(`RevenueLock beneficiary allocation mismatch: ${addresses[i]}`);
    }
  }
}

/** Direct beneficiaries plus the optional reserve must exactly exhaust the lock's budget. */
export function validateReservePlan(
  beneficiaries: RevenueLockBeneficiary[],
  lockTotal: bigint,
  reserve?: RevenueReserveConfig,
): bigint {
  const seen = new Set<string>();
  let directTotal = 0n;
  for (const b of beneficiaries) {
    const address = ethers.getAddress(b.address);
    const amount = ethers.parseUnits(b.amount, 18);
    if (address === ethers.ZeroAddress || seen.has(address) || amount <= 0n) {
      throw new Error("Invalid or duplicate direct RevenueLock beneficiary");
    }
    seen.add(address);
    directTotal += amount;
  }
  const cap = reserve ? ethers.parseUnits(reserve.amount, 18) : 0n;
  if (reserve && (ethers.getAddress(reserve.allocator) === ethers.ZeroAddress || cap <= 0n || cap % 10_000n !== 0n)) {
    throw new Error("Invalid reserve allocator or amount");
  }
  if (directTotal + cap !== lockTotal) {
    throw new Error("Direct RevenueLock allocations plus reserve must equal ARM_REVENUE_LOCK_ALLOCATION");
  }
  return cap;
}

/** Launch scripts support Safe-compatible introspection. Getters do not authenticate
 * wallet code: verify the intended Safe implementation, owners and modules separately. */
export async function assertAllocatorMultisig(address: string): Promise<void> {
  if (await ethers.provider.getCode(address) === "0x") throw new Error("Reserve allocator must be a deployed multisig");
  const wallet = new ethers.Contract(address, [
    "function getThreshold() view returns (uint256)",
    "function getOwners() view returns (address[])",
  ], ethers.provider);
  const [threshold, owners] = await Promise.all([wallet.getThreshold(), wallet.getOwners()]);
  const unique = new Set<string>(owners.map((owner: string) => ethers.getAddress(owner)));
  if (threshold !== 2n || owners.length !== 3 || unique.size !== 3 || unique.has(ethers.ZeroAddress)) {
    throw new Error("Reserve allocator must report exactly three distinct owners and threshold two");
  }
  rejectAnvilAddresses([...unique], "Reserve allocator owners");
}

/** activate() accepts excess funding, but the immutable lock cannot recover it. */
export async function assertRevenueLockAllocation(address: string, expected: bigint): Promise<void> {
  const lock = await ethers.getContractAt("RevenueLock", address);
  const actual = await lock.totalAllocation();
  if (actual !== expected) {
    throw new Error(`RevenueLock totalAllocation mismatch: on-chain ${actual}, configured funding ${expected}`);
  }
}

export interface ReservePreFunding {
  distributorAddress: string;
  allocator: string;
  reserveCap: bigint;
  revenueLockAllocation: bigint;
  directBeneficiaries: RevenueLockBeneficiary[];
  armTokenAddress: string;
  revenueLockAddress: string;
  governorAddress: string;
  windDownAddress: string;
}

/** Must finish before the ARM transfer. This is not an atomic guarantee against
 * another privileged transaction between this read and funding. */
export async function assertReservePreFunding(plan: ReservePreFunding): Promise<void> {
  await assertRevenueLockAllocation(plan.revenueLockAddress, plan.revenueLockAllocation);
  await assertRevenueLockSchedule(plan.revenueLockAddress, plan.directBeneficiaries,
    { address: plan.distributorAddress, cap: plan.reserveCap });
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const distributor = await ethers.getContractAt("RevenueReserveDistributor", plan.distributorAddress);
  const token = await ethers.getContractAt("ArmadaToken", plan.armTokenAddress);
  const lock = await ethers.getContractAt("RevenueLock", plan.revenueLockAddress);
  const governor = await ethers.getContractAt("ArmadaGovernor", plan.governorAddress);
  const windDown = await ethers.getContractAt("ArmadaWindDown", plan.windDownAddress);
  if (!same(await distributor.armToken(), plan.armTokenAddress) ||
      !same(await distributor.revenueLock(), plan.revenueLockAddress) ||
      !same(await distributor.allocator(), plan.allocator) ||
      await distributor.reserveCap() !== plan.reserveCap) {
    throw new Error("Reserve deployment does not match the intended token, lock, allocator or cap");
  }
  if (!await distributor.verifyIntegration()) throw new Error("Reserve integration check failed");
  if (await token.balanceOf(plan.revenueLockAddress) !== 0n || await lock.activated() ||
      await lock.frozenAtWindDown() || await lock.released(plan.distributorAddress) !== 0n) {
    throw new Error("Reserve pre-funding check requires an unfunded, inactive, unfrozen lock");
  }
  const exclusions: string[] = await governor.getExcludedFromQuorum();
  for (const address of [plan.distributorAddress, plan.revenueLockAddress]) {
    if (exclusions.filter(excluded => same(excluded, address)).length !== 1) {
      throw new Error("RevenueLock and reserve distributor must each be quorum-excluded exactly once");
    }
  }
  if (await token.noDelegation(plan.allocator)) {
    throw new Error("Reserve allocator must not be a noDelegation address");
  }
  if (exclusions.some(excluded => same(excluded, plan.allocator)) ||
      same(await governor.treasuryAddress(), plan.allocator)) {
    throw new Error("Reserve allocator must not be a quorum-excluded custody address");
  }
  const counter = await ethers.getContractAt("RevenueCounter", await lock.revenueCounter());
  if (!same(await lock.windDownContract(), plan.windDownAddress) ||
      !same(await counter.windDownContract(), plan.windDownAddress) ||
      !same(await token.windDownContract(), plan.windDownAddress) ||
      !same(await governor.windDownContract(), plan.windDownAddress) ||
      !same(await windDown.revenueLock(), plan.revenueLockAddress) ||
      !same(await windDown.revenueCounter(), await lock.revenueCounter()) ||
      !same(await windDown.armToken(), plan.armTokenAddress) ||
      !same(await windDown.governor(), plan.governorAddress) || await windDown.triggered()) {
    throw new Error("Reserve wind-down wiring is incomplete, mismatched or already active");
  }
  await assertAllocatorMultisig(plan.allocator);
}

/** JSON-safe original constructor input, including beneficiary order. */
export type RevenueLockConstructorArgs = [string, string, string, string[], string[]];

/** Authenticate creation against the reviewed artifact, not contract getters or
 * a manifest-controlled address alone. Creation txs are immutable on the chain. */
export async function assertCreationProvenance(name: "RevenueLock" | "RevenueReserveDistributor",
  address: string, txHash: string | undefined, constructorArgs: readonly unknown[], deployer: string): Promise<void> {
  if (!txHash || !ethers.isHexString(txHash, 32)) throw new Error(`${name} creation transaction missing`);
  const [tx, receipt, factory] = await Promise.all([
    ethers.provider.getTransaction(txHash), ethers.provider.getTransactionReceipt(txHash), ethers.getContractFactory(name),
  ]);
  if (!tx || !receipt || tx.to !== null || receipt.status !== 1 ||
      receipt.hash.toLowerCase() !== txHash.toLowerCase() ||
      !receipt.contractAddress || ethers.getAddress(receipt.contractAddress) !== ethers.getAddress(address) ||
      ethers.getAddress(tx.from) !== ethers.getAddress(deployer)) {
    throw new Error(`${name} creation transaction does not match manifest address/deployer`);
  }
  const expected = (await factory.getDeployTransaction(...constructorArgs)).data;
  if (!expected || tx.data.toLowerCase() !== expected.toLowerCase() ||
      await ethers.provider.getCode(address) === "0x") {
    throw new Error(`${name} creation input does not match reviewed artifact and arguments`);
  }
}

/** Safe to repeat after funding: recheck live wiring without requiring an empty lock. */
export async function assertReservePostFunding(plan: ReservePreFunding & { redemptionAddress: string }): Promise<void> {
  const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
  await assertRevenueLockAllocation(plan.revenueLockAddress, plan.revenueLockAllocation);
  await assertRevenueLockSchedule(plan.revenueLockAddress, plan.directBeneficiaries,
    { address: plan.distributorAddress, cap: plan.reserveCap });
  const token = await ethers.getContractAt("ArmadaToken", plan.armTokenAddress);
  const distributor = await ethers.getContractAt("RevenueReserveDistributor", plan.distributorAddress);
  const lock = await ethers.getContractAt("RevenueLock", plan.revenueLockAddress);
  const governor = await ethers.getContractAt("ArmadaGovernor", plan.governorAddress);
  const windDown = await ethers.getContractAt("ArmadaWindDown", plan.windDownAddress);
  const redemption = await ethers.getContractAt("ArmadaRedemption", plan.redemptionAddress);
  const counter = await ethers.getContractAt("RevenueCounter", await lock.revenueCounter());
  const exclusions: string[] = await governor.getExcludedFromQuorum();
  if (!same(await distributor.armToken(), plan.armTokenAddress) ||
      !same(await distributor.revenueLock(), plan.revenueLockAddress) ||
      !same(await distributor.allocator(), plan.allocator) ||
      await distributor.reserveCap() !== plan.reserveCap ||
      !await distributor.verifyIntegration() ||
      !await lock.activated() ||
      [plan.revenueLockAddress, plan.distributorAddress].some(address =>
        exclusions.filter(excluded => same(address, excluded)).length !== 1) ||
      exclusions.some(excluded => same(excluded, plan.allocator)) ||
      await token.noDelegation(plan.allocator) ||
      same(await governor.treasuryAddress(), plan.allocator) ||
      !same(await lock.windDownContract(), plan.windDownAddress) ||
      !same(await counter.windDownContract(), plan.windDownAddress) ||
      !same(await token.windDownContract(), plan.windDownAddress) ||
      !same(await governor.windDownContract(), plan.windDownAddress) ||
      !same(await windDown.revenueLock(), plan.revenueLockAddress) ||
      !same(await windDown.revenueCounter(), await lock.revenueCounter()) ||
      !same(await windDown.armToken(), plan.armTokenAddress) ||
      !same(await windDown.governor(), plan.governorAddress) ||
      !same(await windDown.redemptionContract(), plan.redemptionAddress) ||
      !same(await redemption.revenueLock(), plan.revenueLockAddress) ||
      !same(await redemption.windDown(), plan.windDownAddress)) {
    throw new Error("Reserve post-funding integration or redemption/wind-down binding mismatch");
  }
  await assertAllocatorMultisig(plan.allocator);
}

type ActivatableLock = {
  activated(): Promise<boolean>;
  activate: {
    (overrides: { gasLimit: bigint; nonce?: number }): Promise<ContractTransactionResponse>;
    estimateGas(): Promise<bigint>;
  };
};

/** Permissionless activation may race deployment. Only tolerate a proven completed
 * activation; never swallow an ambiguous send failure and continue with a nonce gap. */
export async function ensureRevenueLockActivated(lock: ActivatableLock, nm: NonceManager): Promise<void> {
  if (await lock.activated()) return;
  let estimate: bigint;
  try {
    // Estimate before reserving a nonce. Another caller may already have activated.
    estimate = await lock.activate.estimateGas();
  } catch (error) {
    if (await lock.activated()) return;
    throw error;
  }
  // Supplying gas avoids a second estimation after nm.override() consumes a nonce.
  // A race after estimation becomes a mined revert, which also consumes that nonce.
  const tx = await lock.activate({ ...nm.override(), gasLimit: estimate * 120n / 100n + 10_000n });
  try {
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("RevenueLock activation receipt missing or failed");
  } catch (error) {
    const receipt = (error as { receipt?: { hash?: string; status?: number } }).receipt;
    if (receipt?.hash !== tx.hash || receipt.status !== 0 || !await lock.activated()) throw error;
  }
  if (!await lock.activated()) throw new Error("RevenueLock activation not confirmed");
}
