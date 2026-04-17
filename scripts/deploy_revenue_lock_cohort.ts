// ABOUTME: Deploy an additional RevenueLock cohort against an existing governance deployment.
// ABOUTME: Only deploys the immutable lock — registration and funding happen via governance proposal.

/**
 * Deploy Revenue Lock Cohort
 *
 * Deploys a new RevenueLock contract with its own beneficiary list and amounts,
 * reusing the ARM token and RevenueCounter from an existing governance deployment.
 *
 * After deployment, a governance proposal must register the cohort with the token
 * (addToWhitelist + addAuthorizedDelegator) and fund it via treasury.distribute().
 *
 * Usage:
 *   source config/sepolia.env
 *   export REVENUE_LOCK_COHORT_FILE=config/revenue-lock-cohort2-sepolia.json
 *   export REVENUE_LOCK_COHORT_NAME=cohort2
 *   npm run deploy:revenue-lock-cohort:sepolia
 *
 * The cohort JSON file format matches REVENUE_LOCK_BENEFICIARIES_FILE:
 *   [{"address":"0x...","amount":"50","label":"cohort member 1"}, ...]
 *
 * Writes a manifest to deployments/revenue-lock-{name}{-env}.json.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import {
  getNetworkConfig,
  getGovernanceDeploymentFile,
} from "../config/networks";
import {
  createNonceManager,
  rejectAnvilAddresses,
  loadDeployment,
  saveDeployment,
} from "./deploy-utils";

interface Beneficiary {
  address: string;
  amount: string;
  label: string;
}

interface CohortDeployment {
  chainId: number;
  deployer: string;
  deployBlock: number;
  cohortName: string;
  contracts: {
    revenueLock: string;
    armToken: string;
    revenueCounter: string;
  };
  beneficiaries: Beneficiary[];
  totalAllocation: string;
  timestamp: string;
}

function getCohortFilename(cohortName: string): string {
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `revenue-lock-${cohortName}${suffix}.json`;
}

async function main() {
  const config = getNetworkConfig();
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const nm = await createNonceManager(deployer);

  // Load cohort name and beneficiaries
  const cohortName = process.env.REVENUE_LOCK_COHORT_NAME;
  if (!cohortName || !/^[a-zA-Z0-9_-]+$/.test(cohortName)) {
    throw new Error(
      "REVENUE_LOCK_COHORT_NAME is required and must be alphanumeric (letters, digits, _, -).",
    );
  }

  const cohortFile = process.env.REVENUE_LOCK_COHORT_FILE;
  if (!cohortFile) {
    throw new Error(
      "REVENUE_LOCK_COHORT_FILE is required. Point it at a JSON file with the beneficiary list.",
    );
  }
  if (!fs.existsSync(cohortFile)) {
    throw new Error(`Cohort file not found: ${cohortFile}`);
  }

  const beneficiaries = JSON.parse(
    fs.readFileSync(cohortFile, "utf-8"),
  ) as Beneficiary[];
  if (!Array.isArray(beneficiaries) || beneficiaries.length === 0) {
    throw new Error("Cohort file must contain a non-empty array of beneficiaries.");
  }
  for (const b of beneficiaries) {
    if (!b.address || !b.amount || !b.label) {
      throw new Error(
        `Each beneficiary must have address, amount, and label fields. Bad entry: ${JSON.stringify(b)}`,
      );
    }
  }

  // Load governance deployment (reuse armToken + revenueCounter)
  const govFile = getGovernanceDeploymentFile();
  const gov = loadDeployment(govFile);
  if (!gov) {
    throw new Error(`Governance deployment not found: ${govFile}. Deploy governance first.`);
  }
  const armTokenAddress = gov.contracts.armToken as string;
  const revenueCounterAddress = gov.contracts.revenueCounter as string | undefined;
  if (!revenueCounterAddress) {
    throw new Error(
      `RevenueCounter address missing from ${govFile}. Governance deployment must include revenueCounter.`,
    );
  }

  // Safety guard
  const addresses = beneficiaries.map((b) => b.address);
  rejectAnvilAddresses(addresses, "RevenueLock cohort beneficiaries");

  console.log(`Deploying RevenueLock cohort "${cohortName}" (env=${config.env})`);
  console.log(`  ARM token:       ${armTokenAddress}`);
  console.log(`  RevenueCounter:  ${revenueCounterAddress}`);
  console.log(`  Beneficiaries (${beneficiaries.length}):`);
  let totalAllocation = 0n;
  for (const b of beneficiaries) {
    const amountWei = ethers.parseUnits(b.amount, 18);
    totalAllocation += amountWei;
    console.log(`    ${b.address} — ${b.amount} ARM (${b.label})`);
  }
  console.log(`  Total allocation: ${ethers.formatUnits(totalAllocation, 18)} ARM`);

  // Deploy
  const addrArray = beneficiaries.map((b) => b.address);
  const amountArray = beneficiaries.map((b) => ethers.parseUnits(b.amount, 18));

  // $10k/day in 18-decimal USD. See PARAMETER_MANIFEST.md / issue #225 — rate cap on
  // the observed-revenue ratchet, defends against malicious RevenueCounter upgrades.
  const MAX_REVENUE_INCREASE_PER_DAY = ethers.parseUnits("10000", 18);

  const RevenueLock = await ethers.getContractFactory("RevenueLock");
  const lock = await RevenueLock.deploy(
    armTokenAddress,
    revenueCounterAddress,
    MAX_REVENUE_INCREASE_PER_DAY,
    addrArray,
    amountArray,
    nm.override(),
  );
  await lock.deploymentTransaction()!.wait();
  const lockAddress = await lock.getAddress();
  console.log(`  RevenueLock deployed: ${lockAddress}`);

  // Verify read-back
  const onchainTotal = await lock.totalAllocation();
  if (onchainTotal !== totalAllocation) {
    throw new Error(
      `Read-back mismatch: expected ${totalAllocation} wei, got ${onchainTotal} wei`,
    );
  }

  // Save manifest
  const currentBlock = await ethers.provider.getBlockNumber();
  const manifest: CohortDeployment = {
    chainId,
    deployer: deployer.address,
    deployBlock: currentBlock,
    cohortName,
    contracts: {
      revenueLock: lockAddress,
      armToken: armTokenAddress,
      revenueCounter: revenueCounterAddress,
    },
    beneficiaries,
    totalAllocation: ethers.formatUnits(totalAllocation, 18),
    timestamp: new Date().toISOString(),
  };

  const outFile = getCohortFilename(cohortName);
  saveDeployment(outFile, manifest);
  console.log(`\nCohort manifest saved: deployments/${outFile}`);

  console.log("\n=== Cohort deployment complete ===");
  console.log("\nNext steps (via governance proposal):");
  console.log(`  1. armToken.addToWhitelist(${lockAddress})`);
  console.log(`  2. armToken.addAuthorizedDelegator(${lockAddress})`);
  console.log(`  3. treasury.distribute(armToken, ${lockAddress}, ${ethers.formatUnits(totalAllocation, 18)} ARM)`);
  console.log("\nOr use the 'Register Revenue Lock Cohort' template in the governance-ui.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
