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
