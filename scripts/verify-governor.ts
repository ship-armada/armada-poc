// ABOUTME: Checks the governor's one-time bootstrap state: deployer cleared and crowdfund registered.
// ABOUTME: Hardened launches fail on a retained deployer; a missing or wrong crowdfund always fails.
import { ethers } from "hardhat";

type Check = { check: string; status: "PASS" | "WARN" | "FAIL"; detail: string };

/**
 * A retained deployer keeps bootstrap powers (setSecurityCouncil, setExcludedAddresses, ...)
 * outside governance and the Security Council veto. The registered crowdfund drives the
 * governance quiet period and the 70-day veto bootstrap; if it is unset, neither applies.
 * `expectedCrowdfund` is null when no crowdfund manifest exists (the row is then omitted).
 */
export async function governorBootstrapChecks(
  governorAddress: string,
  expectedCrowdfund: string | null,
  hardened: boolean,
): Promise<Check[]> {
  const governor = await ethers.getContractAt("ArmadaGovernor", governorAddress);
  const checks: Check[] = [];

  const deployer = await governor.deployer();
  checks.push(deployer === ethers.ZeroAddress
    ? { check: "Governor deployer cleared", status: "PASS", detail: "" }
    : hardened
      ? { check: "Governor deployer cleared", status: "FAIL",
        detail: `deployer() = ${deployer}: bootstrap powers retained outside governance` }
      : { check: "Governor deployer cleared", status: "WARN",
        detail: `deployer() = ${deployer} (expected if crowdfund not yet deployed)` });

  if (expectedCrowdfund !== null) {
    const registered = await governor.crowdfundAddress();
    const locked = await governor.crowdfundAddressLocked();
    const ok = locked && registered.toLowerCase() === expectedCrowdfund.toLowerCase();
    checks.push({ check: "Governor crowdfund registered", status: ok ? "PASS" : "FAIL",
      detail: ok ? registered
        : `crowdfundAddress() = ${registered}, expected ${expectedCrowdfund}: no quiet period or veto bootstrap` });
  }
  return checks;
}
