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

/** Describes a reserve configured without a deployed distributor, or the reverse.
 * Returns undefined when both are present or both are absent. */
export function reserveConfigMismatch(distributor: string | undefined,
  reserve: RevenueReserveConfig | undefined): string | undefined {
  if (distributor && !reserve) return "Manifest has a reserve distributor but REVENUE_RESERVE_* is unset";
  if (!distributor && reserve) return "REVENUE_RESERVE_* is set but the manifest has no reserve distributor";
  return undefined;
}

/** Launch scripts support Safe-compatible introspection. Getters do not authenticate
 * wallet code: verify the intended Safe implementation, owners and modules separately. */
export async function assertAllocatorMultisig(address: string): Promise<void> {
  await assertTwoOfThreeMultisig(address, "Reserve allocator");
}

/**
 * Callers pass the roles the allocator must not share: the deployer, the security council, whose
 * cancel and veto powers check launch operations (#582), and the launch team, which may be a
 * 1-of-3 Safe and so must not also assign irrevocable grants. Unset roles (empty strings) are
 * skipped.
 */
export function assertAllocatorDistinct(allocator: string, otherRoles: { label: string; address: string }[]): void {
  const address = ethers.getAddress(allocator);
  for (const role of otherRoles) {
    if (role.address && ethers.getAddress(role.address.toLowerCase()) === address) {
      throw new Error(`Reserve allocator must differ from the ${role.label} (${address})`);
    }
  }
}

/**
 * Mainnet security council must be a 2-of-3 Safe, like the steward. The launch team may be a
 * 1-of-3 or 2-of-3 Safe: its signers hold hardware wallets, and its powers end with the
 * commitment window. The two must be different Safes: the council's cancel is the check on
 * launch-team placements. Both are fixed in the crowdfund at deploy, so the governance stage
 * checks before its first transaction and the crowdfund stage re-checks before deploying the
 * crowdfund.
 */
export async function assertLaunchRoleMultisigs(securityCouncil: string, launchTeam: string): Promise<void> {
  if (!securityCouncil) throw new Error("SECURITY_COUNCIL_ADDRESS is required (a 2-of-3 Safe)");
  if (!launchTeam) throw new Error("LAUNCH_TEAM_ADDRESS is required (a 1-of-3 or 2-of-3 Safe)");
  if (securityCouncil.toLowerCase() === launchTeam.toLowerCase()) {
    throw new Error(`Launch team must differ from the security council (${launchTeam})`);
  }
  await assertTwoOfThreeMultisig(securityCouncil, "Security council");
  await assertThreeOwnerMultisig(launchTeam, "Launch team", [1n, 2n], "one or two");
}

/** Safe-compatible 2-of-3 check shared by launch roles held by a multisig (reserve allocator,
 * initial steward and mainnet security council). */
export async function assertTwoOfThreeMultisig(address: string, label: string): Promise<void> {
  await assertThreeOwnerMultisig(address, label, [2n], "two");
}

/** Safe-compatible check for exactly three distinct owners and one of the accepted thresholds
 * (`thresholdText` spells them out for the error). Same caveat: getters do not authenticate the
 * wallet code. */
async function assertThreeOwnerMultisig(address: string, label: string, thresholds: bigint[],
  thresholdText: string): Promise<void> {
  if (await ethers.provider.getCode(address) === "0x") throw new Error(`${label} must be a deployed multisig`);
  const wallet = new ethers.Contract(address, [
    "function getThreshold() view returns (uint256)",
    "function getOwners() view returns (address[])",
  ], ethers.provider);
  const [threshold, owners] = await Promise.all([wallet.getThreshold(), wallet.getOwners()]);
  const unique = new Set<string>(owners.map((owner: string) => ethers.getAddress(owner)));
  if (!thresholds.includes(threshold) || owners.length !== 3 || unique.size !== 3 || unique.has(ethers.ZeroAddress)) {
    throw new Error(`${label} must report exactly three distinct owners and threshold ${thresholdText}`);
  }
  rejectAnvilAddresses([...unique], `${label} owners`);
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

const sameAddress = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

/** Wiring checked both before and after funding: distributor identity and integration,
 * quorum and delegation treatment of the reserve and its allocator, and wind-down bindings. */
async function assertReserveWiring(plan: ReservePreFunding): Promise<void> {
  const distributor = await ethers.getContractAt("RevenueReserveDistributor", plan.distributorAddress);
  const token = await ethers.getContractAt("ArmadaToken", plan.armTokenAddress);
  const lock = await ethers.getContractAt("RevenueLock", plan.revenueLockAddress);
  const governor = await ethers.getContractAt("ArmadaGovernor", plan.governorAddress);
  const windDown = await ethers.getContractAt("ArmadaWindDown", plan.windDownAddress);
  if (!sameAddress(await distributor.armToken(), plan.armTokenAddress) ||
      !sameAddress(await distributor.revenueLock(), plan.revenueLockAddress) ||
      !sameAddress(await distributor.allocator(), plan.allocator) ||
      await distributor.reserveCap() !== plan.reserveCap) {
    throw new Error("Reserve deployment does not match the intended token, lock, allocator or cap");
  }
  if (!await distributor.verifyIntegration()) throw new Error("Reserve integration check failed");
  const exclusions: string[] = await governor.getExcludedFromQuorum();
  for (const address of [plan.distributorAddress, plan.revenueLockAddress]) {
    if (exclusions.filter(excluded => sameAddress(excluded, address)).length !== 1) {
      throw new Error("RevenueLock and reserve distributor must each be quorum-excluded exactly once");
    }
  }
  if (await token.noDelegation(plan.allocator)) {
    throw new Error("Reserve allocator must not be a noDelegation address");
  }
  if (exclusions.some(excluded => sameAddress(excluded, plan.allocator)) ||
      sameAddress(await governor.treasuryAddress(), plan.allocator)) {
    throw new Error("Reserve allocator must not be a quorum-excluded custody address");
  }
  const counter = await ethers.getContractAt("RevenueCounter", await lock.revenueCounter());
  if (!sameAddress(await lock.windDownContract(), plan.windDownAddress) ||
      !sameAddress(await counter.windDownContract(), plan.windDownAddress) ||
      !sameAddress(await token.windDownContract(), plan.windDownAddress) ||
      !sameAddress(await governor.windDownContract(), plan.windDownAddress) ||
      !sameAddress(await windDown.revenueLock(), plan.revenueLockAddress) ||
      !sameAddress(await windDown.revenueCounter(), await lock.revenueCounter()) ||
      !sameAddress(await windDown.armToken(), plan.armTokenAddress) ||
      !sameAddress(await windDown.governor(), plan.governorAddress)) {
    throw new Error("Reserve wind-down wiring is incomplete or mismatched");
  }
  await assertAllocatorMultisig(plan.allocator);
}

/** Must finish before the ARM transfer. This is not an atomic guarantee against
 * another privileged transaction between this read and funding. */
export async function assertReservePreFunding(plan: ReservePreFunding): Promise<void> {
  await assertRevenueLockAllocation(plan.revenueLockAddress, plan.revenueLockAllocation);
  await assertRevenueLockSchedule(plan.revenueLockAddress, plan.directBeneficiaries,
    { address: plan.distributorAddress, cap: plan.reserveCap });
  const token = await ethers.getContractAt("ArmadaToken", plan.armTokenAddress);
  const lock = await ethers.getContractAt("RevenueLock", plan.revenueLockAddress);
  if (await token.balanceOf(plan.revenueLockAddress) !== 0n || await lock.activated() ||
      await lock.frozenAtWindDown() || await lock.released(plan.distributorAddress) !== 0n) {
    throw new Error("Reserve pre-funding check requires an unfunded, inactive, unfrozen lock");
  }
  await assertReserveWiring(plan);
  const windDown = await ethers.getContractAt("ArmadaWindDown", plan.windDownAddress);
  if (await windDown.triggered()) throw new Error("Reserve wind-down wiring is already active");
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
  await assertRevenueLockAllocation(plan.revenueLockAddress, plan.revenueLockAllocation);
  await assertRevenueLockSchedule(plan.revenueLockAddress, plan.directBeneficiaries,
    { address: plan.distributorAddress, cap: plan.reserveCap });
  const lock = await ethers.getContractAt("RevenueLock", plan.revenueLockAddress);
  if (!await lock.activated()) throw new Error("Reserve post-funding check requires an activated lock");
  await assertReserveWiring(plan);
  const windDown = await ethers.getContractAt("ArmadaWindDown", plan.windDownAddress);
  const redemption = await ethers.getContractAt("ArmadaRedemption", plan.redemptionAddress);
  if (!sameAddress(await windDown.redemptionContract(), plan.redemptionAddress) ||
      !sameAddress(await redemption.revenueLock(), plan.revenueLockAddress) ||
      !sameAddress(await redemption.windDown(), plan.windDownAddress)) {
    throw new Error("Reserve redemption/wind-down binding mismatch");
  }
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
