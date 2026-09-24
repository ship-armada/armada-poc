// ABOUTME: Checks actual timelock bootstrap roles and the configured production delay.
// ABOUTME: Hardened launches fail on retained deployer authority; partial deployments warn.
import { ethers } from "hardhat";

export async function timelockBootstrapChecks(address: string, deployer: string, expectedDelay?: bigint) {
  const timelock = await ethers.getContractAt("TimelockController", address);
  const checks: { check: string; status: "PASS" | "WARN" | "FAIL"; detail: string }[] = [];
  for (const [name, role] of [
    ["TIMELOCK_ADMIN_ROLE", await timelock.TIMELOCK_ADMIN_ROLE()],
    ["PROPOSER_ROLE", await timelock.PROPOSER_ROLE()],
    ["EXECUTOR_ROLE", await timelock.EXECUTOR_ROLE()],
    ["CANCELLER_ROLE", await timelock.CANCELLER_ROLE()],
  ]) {
    const retained = await timelock.hasRole(role, deployer);
    checks.push({ check: `Deployer renounced ${name}`,
      status: retained ? (expectedDelay === undefined ? "WARN" : "FAIL") : "PASS",
      detail: retained ? `Deployer retains ${name}` : "" });
  }
  if (expectedDelay !== undefined) {
    const actual = await timelock.getMinDelay();
    checks.push({ check: "Production timelock delay", status: actual === expectedDelay ? "PASS" : "FAIL",
      detail: `Expected ${expectedDelay}s, actual ${actual}s` });
  }
  return checks;
}

/** Enumerate historical role holders, then verify their current membership. The
 * timelock's AccessControl implementation has no enumerable role membership. */
export async function timelockUnexpectedRoleHolders(address: string, fromBlock: number,
  expectedGovernor: string): Promise<string[]> {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) throw new Error("Invalid timelock deployment block");
  const timelock = await ethers.getContractAt("TimelockController", address);
  const topics = [timelock.interface.getEvent("RoleGranted")!.topicHash,
    timelock.interface.getEvent("RoleRevoked")!.topicHash];
  const accounts = new Map<string, string>();
  const latest = await ethers.provider.getBlockNumber();
  for (let start = fromBlock; start <= latest; start += 5000) {
    const logs = await ethers.provider.getLogs({ address, fromBlock: start,
      toBlock: Math.min(start + 4999, latest), topics: [topics] });
    for (const log of logs) {
      const parsed = timelock.interface.parseLog(log);
      if (parsed) accounts.set(ethers.getAddress(parsed.args.account), parsed.args.account);
    }
  }
  const roles = [await timelock.TIMELOCK_ADMIN_ROLE(), await timelock.PROPOSER_ROLE(),
    await timelock.EXECUTOR_ROLE(), await timelock.CANCELLER_ROLE()];
  const unexpected: string[] = [];
  for (const account of accounts.values()) {
    for (const role of roles) {
      const permitted = role === roles[0]
        ? ethers.getAddress(account) === ethers.getAddress(address)
        : ethers.getAddress(account) === ethers.getAddress(expectedGovernor);
      if (await timelock.hasRole(role, account) && !permitted) unexpected.push(`${account}: ${role}`);
    }
  }
  return unexpected;
}
