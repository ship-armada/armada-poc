// ABOUTME: Comprehensive post-deployment verification script for Armada protocol.
// ABOUTME: Checks all cross-contract wiring, roles, parameters, and token distributions.

/**
 * Verify Deployment
 *
 * Runs on-chain checks against deployment manifests to verify that all contracts
 * are correctly wired, roles are assigned, and parameters are set.
 *
 * Graceful degradation: missing manifests produce WARN (not FAIL), so the script
 * works at any stage of incremental deployment.
 *
 * Usage:
 *   npx hardhat run scripts/verify_deployment.ts --network hub
 *   npx hardhat run scripts/verify_deployment.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import { loadDeployment } from "./deploy-utils";
import {
  isLocal,
  getNetworkConfig,
  getCCTPDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getGovernanceDeploymentFile,
  getYieldDeploymentFile,
  getCrowdfundDeploymentFile,
} from "../config/networks";

// ============================================================================
// Result tracking
// ============================================================================

type Status = "PASS" | "WARN" | "FAIL";

interface CheckResult {
  group: string;
  check: string;
  status: Status;
  detail: string;
}

const results: CheckResult[] = [];

function pass(group: string, check: string, detail = "") {
  results.push({ group, check, status: "PASS", detail });
}

function warn(group: string, check: string, detail: string) {
  results.push({ group, check, status: "WARN", detail });
}

function fail(group: string, check: string, detail: string) {
  results.push({ group, check, status: "FAIL", detail });
}

// ============================================================================
// Helpers
// ============================================================================

/** Pad an address to bytes32 (left-pad with zeros) */
function addressToBytes32(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

/** Load manifest or return null with a warning */
function loadOrWarn(group: string, filename: string): any | null {
  const data = loadDeployment(filename);
  if (!data) {
    warn(group, `Load ${filename}`, `Manifest not found — skipping group`);
  }
  return data;
}

// ============================================================================
// Check Group 1: SNARK Verification
// ============================================================================

async function checkSnarkVerification(poolManifest: any) {
  const GROUP = "SNARK Verification";
  const poolAddr = poolManifest.contracts.privacyPool;
  const pool = await ethers.getContractAt("PrivacyPool", poolAddr);

  // testingMode must be false
  const testingMode = await pool.testingMode();
  if (testingMode) {
    fail(GROUP, "testingMode disabled", "testingMode is TRUE — proofs are NOT being verified");
  } else {
    pass(GROUP, "testingMode disabled");
  }

  // Verification keys loaded (must match TESTING_ARTIFACT_CONFIGS in lib/artifacts.ts)
  const configs = [[1,1], [1,2], [2,2], [2,3], [8,4]];
  for (const [n, c] of configs) {
    try {
      const vk = await pool.getVerificationKey(n, c);
      if (vk.alpha1.x !== 0n) {
        pass(GROUP, `VK[${n}x${c}] loaded`);
      } else {
        fail(GROUP, `VK[${n}x${c}] loaded`, "Verification key not set (alpha1.x == 0)");
      }
    } catch {
      fail(GROUP, `VK[${n}x${c}] loaded`, "Error reading verification key");
    }
  }

  // Shield fee
  try {
    const shieldFee = await pool.shieldFee();
    if (shieldFee === 50n) {
      pass(GROUP, "Shield fee = 50 bps");
    } else {
      fail(GROUP, "Shield fee = 50 bps", `Actual: ${shieldFee} bps`);
    }
  } catch {
    fail(GROUP, "Shield fee = 50 bps", "Error reading shieldFee");
  }
}

// ============================================================================
// Check Group 2: CCTP Wiring
// ============================================================================

async function checkCCTPWiring(hubCCTP: any) {
  const GROUP = "CCTP Wiring";

  const usdc = await ethers.getContractAt("MockUSDCV2", hubCCTP.contracts.usdc);
  const tokenMessengerAddr = hubCCTP.contracts.tokenMessenger;

  // TokenMessenger is minter on USDC (MockUSDCV2 uses `minters` public mapping)
  try {
    const isMinter = await usdc.minters(tokenMessengerAddr);
    if (isMinter) {
      pass(GROUP, "TokenMessenger is USDC minter");
    } else {
      fail(GROUP, "TokenMessenger is USDC minter", "TokenMessenger not authorized as minter");
    }
  } catch {
    fail(GROUP, "TokenMessenger is USDC minter", "Error checking minter role");
  }

  // MessageTransmitter has tokenMessenger set
  try {
    const mt = await ethers.getContractAt("MockMessageTransmitterV2", hubCCTP.contracts.messageTransmitter);
    const tmOnMT = await mt.tokenMessenger();
    if (tmOnMT.toLowerCase() === tokenMessengerAddr.toLowerCase()) {
      pass(GROUP, "MessageTransmitter → TokenMessenger link");
    } else {
      fail(GROUP, "MessageTransmitter → TokenMessenger link", `Expected ${tokenMessengerAddr}, got ${tmOnMT}`);
    }
  } catch {
    fail(GROUP, "MessageTransmitter → TokenMessenger link", "Error reading tokenMessenger from MessageTransmitter");
  }
}

// ============================================================================
// Check Group 3: Privacy Pool Wiring
// ============================================================================

async function checkPrivacyPoolWiring(
  hubPoolManifest: any,
  govManifest: any | null,
  yieldManifest: any | null,
  feeManifest: any | null,
) {
  const GROUP = "Privacy Pool Wiring";
  const poolAddr = hubPoolManifest.contracts.privacyPool;
  const pool = await ethers.getContractAt("PrivacyPool", poolAddr);

  // Check client pool linking
  for (const role of ["clientA", "clientB"] as const) {
    const clientFile = getPrivacyPoolDeploymentFile(role);
    const clientManifest = loadDeployment(clientFile);
    if (!clientManifest) {
      warn(GROUP, `Remote pool (${role})`, `${clientFile} not found`);
      continue;
    }

    const clientDomain = clientManifest.domain;
    const clientPoolAddr = clientManifest.contracts.privacyPoolClient;
    const expectedBytes32 = addressToBytes32(clientPoolAddr);

    try {
      const registered = await pool.remotePools(clientDomain);
      if (registered.toLowerCase() === expectedBytes32) {
        pass(GROUP, `Remote pool (${role}) domain=${clientDomain}`);
      } else {
        fail(GROUP, `Remote pool (${role}) domain=${clientDomain}`,
          `Expected ${expectedBytes32}, got ${registered}`);
      }
    } catch {
      fail(GROUP, `Remote pool (${role}) domain=${clientDomain}`, "Error reading remotePools");
    }
  }

  // Hook router
  try {
    const hookRouter = await pool.hookRouter();
    if (hookRouter.toLowerCase() === hubPoolManifest.contracts.hookRouter.toLowerCase()) {
      pass(GROUP, "Hook router set");
    } else {
      fail(GROUP, "Hook router set",
        `Expected ${hubPoolManifest.contracts.hookRouter}, got ${hookRouter}`);
    }
  } catch {
    fail(GROUP, "Hook router set", "Error reading hookRouter");
  }

  // Shield pause controller
  if (govManifest?.contracts?.shieldPauseController) {
    try {
      const pauseContract = await pool.shieldPauseContract();
      if (pauseContract.toLowerCase() === govManifest.contracts.shieldPauseController.toLowerCase()) {
        pass(GROUP, "ShieldPauseController linked");
      } else {
        fail(GROUP, "ShieldPauseController linked",
          `Expected ${govManifest.contracts.shieldPauseController}, got ${pauseContract}`);
      }
    } catch {
      fail(GROUP, "ShieldPauseController linked", "Error reading shieldPauseContract");
    }
  }

  // Fee module
  if (feeManifest?.contracts?.feeModuleProxy) {
    try {
      const feeModule = await pool.feeModule();
      if (feeModule.toLowerCase() === feeManifest.contracts.feeModuleProxy.toLowerCase()) {
        pass(GROUP, "FeeModule linked to pool");
      } else {
        fail(GROUP, "FeeModule linked to pool",
          `Expected ${feeManifest.contracts.feeModuleProxy}, got ${feeModule}`);
      }
    } catch {
      fail(GROUP, "FeeModule linked to pool", "Error reading feeModule");
    }
  }

  // Yield adapter is privileged shield caller
  if (yieldManifest?.contracts?.armadaYieldAdapter) {
    try {
      const isPrivileged = await pool.privilegedShieldCallers(yieldManifest.contracts.armadaYieldAdapter);
      if (isPrivileged) {
        pass(GROUP, "Yield adapter is privileged shield caller");
      } else {
        fail(GROUP, "Yield adapter is privileged shield caller", "Adapter not authorized");
      }
    } catch {
      fail(GROUP, "Yield adapter is privileged shield caller", "Error reading privilegedShieldCallers");
    }
  }
}

// ============================================================================
// Check Group 4: Governance Wiring
// ============================================================================

async function checkGovernanceWiring(govManifest: any) {
  const GROUP = "Governance Wiring";
  const timelockAddr = govManifest.contracts.timelockController;
  const governorAddr = govManifest.contracts.governor;

  const timelock = await ethers.getContractAt("TimelockController", timelockAddr);
  const governor = await ethers.getContractAt("ArmadaGovernor", governorAddr);

  // Timelock roles
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const TIMELOCK_ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();

  for (const [roleName, roleHash] of [
    ["PROPOSER_ROLE", PROPOSER_ROLE],
    ["EXECUTOR_ROLE", EXECUTOR_ROLE],
    ["CANCELLER_ROLE", CANCELLER_ROLE],
  ] as const) {
    const hasRole = await timelock.hasRole(roleHash, governorAddr);
    if (hasRole) {
      pass(GROUP, `Governor has ${roleName}`);
    } else {
      fail(GROUP, `Governor has ${roleName}`, `Governor ${governorAddr} lacks role on timelock`);
    }
  }

  // Deployer renounced admin
  const deployerAddr = govManifest.deployer;
  const deployerHasAdmin = await timelock.hasRole(TIMELOCK_ADMIN_ROLE, deployerAddr);
  if (deployerHasAdmin) {
    warn(GROUP, "Deployer renounced timelock admin",
      "Deployer still has TIMELOCK_ADMIN_ROLE (expected if crowdfund not yet deployed)");
  } else {
    pass(GROUP, "Deployer renounced timelock admin");
  }

  // Governor → steward link
  if (govManifest.contracts.steward) {
    try {
      const steward = await governor.stewardContract();
      if (steward.toLowerCase() === govManifest.contracts.steward.toLowerCase()) {
        pass(GROUP, "Governor → steward link");
      } else {
        fail(GROUP, "Governor → steward link",
          `Expected ${govManifest.contracts.steward}, got ${steward}`);
      }
    } catch {
      fail(GROUP, "Governor → steward link", "Error reading stewardContract");
    }
  }

  // Deployer cleared
  try {
    const currentDeployer = await governor.deployer();
    if (currentDeployer === ethers.ZeroAddress) {
      pass(GROUP, "Governor deployer cleared");
    } else {
      warn(GROUP, "Governor deployer cleared",
        `deployer() = ${currentDeployer} (expected if crowdfund not yet deployed)`);
    }
  } catch {
    fail(GROUP, "Governor deployer cleared", "Error reading deployer");
  }
}

// ============================================================================
// Check Group 5: Yield + Fee Module Wiring
// ============================================================================

async function checkYieldFeeWiring(
  yieldManifest: any,
  feeManifest: any | null,
  govManifest: any | null,
) {
  const GROUP = "Yield + Fee Wiring";
  const vaultAddr = yieldManifest.contracts.armadaYieldVault;
  const adapterAddr = yieldManifest.contracts.armadaYieldAdapter;
  const treasuryAddr = yieldManifest.contracts.armadaTreasury;

  const vault = await ethers.getContractAt("ArmadaYieldVault", vaultAddr);

  // Adapter set on vault
  try {
    const adapter = await vault.adapter();
    if (adapter.toLowerCase() === adapterAddr.toLowerCase()) {
      pass(GROUP, "YieldVault adapter set");
    } else {
      fail(GROUP, "YieldVault adapter set", `Expected ${adapterAddr}, got ${adapter}`);
    }
  } catch {
    fail(GROUP, "YieldVault adapter set", "Error reading adapter");
  }

  // Fee module on vault
  if (feeManifest?.contracts?.feeModuleProxy) {
    try {
      const vaultFeeModule = await vault.feeModule();
      if (vaultFeeModule.toLowerCase() === feeManifest.contracts.feeModuleProxy.toLowerCase()) {
        pass(GROUP, "YieldVault feeModule set");
      } else {
        fail(GROUP, "YieldVault feeModule set",
          `Expected ${feeManifest.contracts.feeModuleProxy}, got ${vaultFeeModule}`);
      }
    } catch {
      fail(GROUP, "YieldVault feeModule set", "Error reading feeModule");
    }
  }

  // Ownership transferred to timelock
  if (govManifest?.contracts?.timelockController) {
    const timelockAddr = govManifest.contracts.timelockController;

    for (const [name, addr] of [
      ["YieldVault", vaultAddr],
      ["YieldAdapter", adapterAddr],
      ["ArmadaTreasury", treasuryAddr],
    ]) {
      try {
        const contract = await ethers.getContractAt("Ownable", addr);
        const owner = await contract.owner();
        if (owner.toLowerCase() === timelockAddr.toLowerCase()) {
          pass(GROUP, `${name} owned by timelock`);
        } else {
          warn(GROUP, `${name} owned by timelock`,
            `Owner is ${owner} (expected if fee module not yet deployed)`);
        }
      } catch {
        fail(GROUP, `${name} owned by timelock`, "Error reading owner");
      }
    }
  }

  // Adapter authorized in registry
  if (govManifest?.contracts?.adapterRegistry) {
    try {
      const registry = await ethers.getContractAt("AdapterRegistry", govManifest.contracts.adapterRegistry);
      const isAuthorized = await registry.authorizedAdapters(adapterAddr);
      if (isAuthorized) {
        pass(GROUP, "Adapter authorized in registry");
      } else {
        warn(GROUP, "Adapter authorized in registry",
          "Adapter not authorized (expected if link step not yet run)");
      }
    } catch {
      fail(GROUP, "Adapter authorized in registry", "Error reading authorizedAdapters");
    }
  }

  // Revenue counter fee collector
  if (govManifest?.contracts?.revenueCounter && feeManifest?.contracts?.feeModuleProxy) {
    try {
      const revenueCounter = await ethers.getContractAt(
        "RevenueCounter", govManifest.contracts.revenueCounter
      );
      const feeCollector = await revenueCounter.feeCollector();
      if (feeCollector.toLowerCase() === feeManifest.contracts.feeModuleProxy.toLowerCase()) {
        pass(GROUP, "RevenueCounter feeCollector set");
      } else {
        warn(GROUP, "RevenueCounter feeCollector set",
          `feeCollector is ${feeCollector} (expected if fee module not yet deployed)`);
      }
    } catch {
      fail(GROUP, "RevenueCounter feeCollector set", "Error reading feeCollector");
    }
  }
}

// ============================================================================
// Check Group 6: ARM Token + Crowdfund
// ============================================================================

async function checkArmTokenCrowdfund(govManifest: any, crowdfundManifest: any) {
  const GROUP = "ARM Token + Crowdfund";
  const armTokenAddr = govManifest.contracts.armToken;
  const armToken = await ethers.getContractAt("ArmadaToken", armTokenAddr);

  // Total supply
  const totalSupply = await armToken.totalSupply();
  const expected12M = ethers.parseUnits("12000000", 18);
  if (totalSupply === expected12M) {
    pass(GROUP, "ARM total supply = 12M");
  } else {
    fail(GROUP, "ARM total supply = 12M", `Actual: ${ethers.formatUnits(totalSupply, 18)}`);
  }

  // Deployer balance should be 0
  const deployerBalance = await armToken.balanceOf(govManifest.deployer);
  if (deployerBalance === 0n) {
    pass(GROUP, "Deployer ARM balance = 0");
  } else {
    warn(GROUP, "Deployer ARM balance = 0",
      `Deployer holds ${ethers.formatUnits(deployerBalance, 18)} ARM (expected if crowdfund not yet deployed)`);
  }

  // Crowdfund ARM loaded
  try {
    const crowdfund = await ethers.getContractAt("ArmadaCrowdfund", crowdfundManifest.contracts.crowdfund);
    const armLoaded = await crowdfund.armLoaded();
    if (armLoaded) {
      pass(GROUP, "Crowdfund ARM loaded");
    } else {
      fail(GROUP, "Crowdfund ARM loaded", "armLoaded() is false");
    }
  } catch {
    fail(GROUP, "Crowdfund ARM loaded", "Error reading armLoaded");
  }

  // Treasury balance
  if (govManifest.config?.treasuryAllocation) {
    const treasuryBalance = await armToken.balanceOf(govManifest.contracts.treasury);
    const expectedTreasury = ethers.parseUnits(govManifest.config.treasuryAllocation, 18);
    if (treasuryBalance === expectedTreasury) {
      pass(GROUP, "Treasury ARM allocation correct");
    } else {
      warn(GROUP, "Treasury ARM allocation correct",
        `Expected ${govManifest.config.treasuryAllocation}, got ${ethers.formatUnits(treasuryBalance, 18)}`);
    }
  }
}

// ============================================================================
// Check Group 7: Wind-Down Wiring
// ============================================================================

async function checkWindDownWiring(govManifest: any) {
  const GROUP = "Wind-Down Wiring";
  const windDownAddr = govManifest.contracts.windDown;

  if (!windDownAddr || windDownAddr === ethers.ZeroAddress) {
    warn(GROUP, "Wind-down contract deployed",
      "windDown address is zero — expected if crowdfund not yet deployed");
    return;
  }

  // Check windDown on governor
  const governor = await ethers.getContractAt("ArmadaGovernor", govManifest.contracts.governor);
  try {
    const govWindDown = await governor.windDownContract();
    if (govWindDown.toLowerCase() === windDownAddr.toLowerCase()) {
      pass(GROUP, "WindDown set on Governor");
    } else {
      fail(GROUP, "WindDown set on Governor", `Expected ${windDownAddr}, got ${govWindDown}`);
    }
  } catch {
    fail(GROUP, "WindDown set on Governor", "Error reading windDownContract");
  }

  // Check windDown on ARM token
  const armToken = await ethers.getContractAt("ArmadaToken", govManifest.contracts.armToken);
  try {
    const tokenWindDown = await armToken.windDownContract();
    if (tokenWindDown.toLowerCase() === windDownAddr.toLowerCase()) {
      pass(GROUP, "WindDown set on ARM token");
    } else {
      fail(GROUP, "WindDown set on ARM token", `Expected ${windDownAddr}, got ${tokenWindDown}`);
    }
  } catch {
    fail(GROUP, "WindDown set on ARM token", "Error reading windDownContract");
  }

  // Check windDown on treasury
  const treasury = await ethers.getContractAt("ArmadaTreasuryGov", govManifest.contracts.treasury);
  try {
    const treasuryWindDown = await treasury.windDownContract();
    if (treasuryWindDown.toLowerCase() === windDownAddr.toLowerCase()) {
      pass(GROUP, "WindDown set on Treasury");
    } else {
      fail(GROUP, "WindDown set on Treasury", `Expected ${windDownAddr}, got ${treasuryWindDown}`);
    }
  } catch {
    fail(GROUP, "WindDown set on Treasury", "Error reading windDownContract");
  }

  // Check windDown on shield pause controller
  if (govManifest.contracts.shieldPauseController) {
    const pause = await ethers.getContractAt(
      "ShieldPauseController", govManifest.contracts.shieldPauseController
    );
    try {
      const pauseWindDown = await pause.windDownContract();
      if (pauseWindDown.toLowerCase() === windDownAddr.toLowerCase()) {
        pass(GROUP, "WindDown set on ShieldPauseController");
      } else {
        fail(GROUP, "WindDown set on ShieldPauseController",
          `Expected ${windDownAddr}, got ${pauseWindDown}`);
      }
    } catch {
      fail(GROUP, "WindDown set on ShieldPauseController", "Error reading windDownContract");
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== Armada Deployment Verification ===\n");

  const config = getNetworkConfig();
  console.log(`Environment: ${config.env}`);
  console.log(`CCTP Mode: ${config.cctpMode}\n`);

  // Load manifests
  const hubCCTPFile = getCCTPDeploymentFile("hub");
  const hubPoolFile = getPrivacyPoolDeploymentFile("hub");
  const govFile = getGovernanceDeploymentFile();
  const yieldFile = getYieldDeploymentFile();
  const crowdfundFile = getCrowdfundDeploymentFile();
  const suffix = config.env === "local" ? "" : `-${config.env}Hub`;
  const feeFile = config.env === "local" ? "fee-module-hub.json" : `fee-module-hub-${config.env}.json`;

  const hubCCTP = loadOrWarn("CCTP Wiring", hubCCTPFile);
  const hubPool = loadOrWarn("SNARK Verification", hubPoolFile);
  const govManifest = loadOrWarn("Governance Wiring", govFile);
  const yieldManifest = loadOrWarn("Yield + Fee Wiring", yieldFile);
  const crowdfundManifest = loadOrWarn("ARM Token + Crowdfund", crowdfundFile);
  const feeManifest = loadDeployment(feeFile); // Soft load — no group-level warn

  // Run check groups (each group only runs if its prerequisite manifests exist)
  if (hubPool) {
    await checkSnarkVerification(hubPool);
  }

  if (hubCCTP) {
    await checkCCTPWiring(hubCCTP);
  }

  if (hubPool) {
    await checkPrivacyPoolWiring(hubPool, govManifest, yieldManifest, feeManifest);
  }

  if (govManifest) {
    await checkGovernanceWiring(govManifest);
    await checkWindDownWiring(govManifest);
  }

  if (yieldManifest) {
    await checkYieldFeeWiring(yieldManifest, feeManifest, govManifest);
  }

  if (govManifest && crowdfundManifest) {
    await checkArmTokenCrowdfund(govManifest, crowdfundManifest);
  }

  // Print results table
  console.log("\n" + "=".repeat(90));
  console.log("  VERIFICATION RESULTS");
  console.log("=".repeat(90));

  const maxGroup = Math.max(...results.map(r => r.group.length));
  const maxCheck = Math.max(...results.map(r => r.check.length));

  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "WARN" ? "⚠" : "✗";
    const statusStr = `${icon} ${r.status}`;
    const line = `  ${r.group.padEnd(maxGroup)}  ${r.check.padEnd(maxCheck)}  ${statusStr}`;
    console.log(line);
    if (r.detail && r.status !== "PASS") {
      console.log(`  ${"".padEnd(maxGroup)}  ${"".padEnd(maxCheck)}    → ${r.detail}`);
    }
  }

  console.log("=".repeat(90));

  const passes = results.filter(r => r.status === "PASS").length;
  const warns = results.filter(r => r.status === "WARN").length;
  const fails = results.filter(r => r.status === "FAIL").length;

  console.log(`\n  ${passes} passed, ${warns} warnings, ${fails} failed\n`);

  if (fails > 0) {
    console.log("  DEPLOYMENT VERIFICATION FAILED\n");
    process.exit(1);
  } else if (warns > 0) {
    console.log("  Deployment verified with warnings (may be expected for partial deployments)\n");
  } else {
    console.log("  ALL CHECKS PASSED\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
