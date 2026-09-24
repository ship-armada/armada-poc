// ABOUTME: Validates reserve allocation plans and gates irreversible RevenueLock funding.
// ABOUTME: Shared by deployment scripts and tests; never sends transactions.
import { ethers } from "hardhat";
import type { RevenueLockBeneficiary } from "../config/networks";
import { rejectAnvilAddresses } from "./deploy-utils";

export type RevenueReserveConfig = { allocator: string; amount: string };

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
  armTokenAddress: string;
  revenueLockAddress: string;
  governorAddress: string;
  windDownAddress: string;
}

/** Must finish before the ARM transfer. This is not an atomic guarantee against
 * another privileged transaction between this read and funding. */
export async function assertReservePreFunding(plan: ReservePreFunding): Promise<void> {
  await assertRevenueLockAllocation(plan.revenueLockAddress, plan.revenueLockAllocation);
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
