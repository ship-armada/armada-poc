// ABOUTME: Deployment script for ArmadaFeeModule (UUPS proxy) and wiring to PrivacyPool, YieldVault, and RevenueCounter.
// ABOUTME: Registers governance extended selectors for fee module setters on ArmadaGovernor.

/**
 * Deploy ArmadaFeeModule
 *
 * Deploys:
 * - ArmadaFeeModule implementation
 * - ERC1967Proxy with initialize() calldata
 *
 * Post-deploy configuration:
 * - PrivacyPool.setFeeModule(feeModuleProxy)
 * - ArmadaYieldVault.setFeeModule(feeModuleProxy)
 * - RevenueCounter.setFeeCollector(feeModuleProxy)
 * - Register extended selectors on ArmadaGovernor
 *
 * Prerequisites: Governance, PrivacyPool, and YieldVault must be deployed.
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_fee_module.ts --network hub
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { createNonceManager } from "./deploy-utils";

// Fee module governance selectors to register as Extended proposals
const FEE_MODULE_EXTENDED_SELECTORS = [
  "setBaseArmadaTake(uint256)",
  "addTier(uint256,uint256)",
  "setTier(uint256,uint256,uint256)",
  "removeTier(uint256)",
  "setYieldFee(uint256)",
  "setIntegratorTerms(address,uint256,uint256,bool)",
];

function loadDeployment(filename: string): any | null {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveDeployment(filename: string, data: any): void {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const filePath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const [deployer] = await ethers.getSigners();
  const nm = await createNonceManager(deployer);

  console.log(`\n=== Deploying ArmadaFeeModule on chain ${chainId} ===`);
  console.log(`Deployer: ${deployer.address}`);

  // Load existing deployments
  const isSepolia = chainId !== 31337 && chainId !== 1337;
  const hubFile = isSepolia ? "hub-sepolia-v3.json" : "hub-v3.json";
  const govFile = isSepolia ? "governance-sepolia.json" : "governance.json";

  const hubDeployment = loadDeployment(hubFile);
  const govDeployment = loadDeployment(govFile);

  if (!hubDeployment) throw new Error(`Hub deployment not found: ${hubFile}`);
  if (!govDeployment) throw new Error(`Governance deployment not found: ${govFile}`);

  const privacyPoolAddress = hubDeployment.hubPrivacyPool;
  const yieldVaultAddress = hubDeployment.yieldVault;
  const treasuryAddress = govDeployment.treasury;
  const timelockAddress = govDeployment.timelock;
  const governorAddress = govDeployment.governor;
  const revenueCounterAddress = govDeployment.revenueCounter;

  console.log(`PrivacyPool: ${privacyPoolAddress}`);
  console.log(`YieldVault:  ${yieldVaultAddress}`);
  console.log(`Treasury:    ${treasuryAddress}`);
  console.log(`Timelock:    ${timelockAddress}`);

  // 1. Deploy ArmadaFeeModule implementation
  console.log("\n--- Deploying ArmadaFeeModule implementation ---");
  const ArmadaFeeModule = await ethers.getContractFactory("ArmadaFeeModule");
  const feeModuleImpl = await ArmadaFeeModule.deploy(nm.override());
  await feeModuleImpl.deploymentTransaction()!.wait();
  const feeModuleImplAddress = await feeModuleImpl.getAddress();
  console.log(`   ArmadaFeeModule (impl): ${feeModuleImplAddress}`);

  // 2. Deploy ERC1967Proxy with initialize() calldata
  // For local dev: owner = deployer (direct control). For testnet/prod: owner = timelock.
  const ownerAddress = isSepolia ? timelockAddress : deployer.address;

  const initData = ArmadaFeeModule.interface.encodeFunctionData("initialize", [
    ownerAddress,
    treasuryAddress,
    privacyPoolAddress,
    yieldVaultAddress,
  ]);

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const feeModuleProxy = await ERC1967Proxy.deploy(
    feeModuleImplAddress, initData, nm.override()
  );
  await feeModuleProxy.deploymentTransaction()!.wait();
  const feeModuleProxyAddress = await feeModuleProxy.getAddress();
  console.log(`   ArmadaFeeModule (proxy): ${feeModuleProxyAddress}`);

  // 3. Wire fee module into PrivacyPool
  console.log("\n--- Wiring fee module into PrivacyPool ---");
  const privacyPool = await ethers.getContractAt("PrivacyPool", privacyPoolAddress);
  const setFeeModuleTx1 = await privacyPool.setFeeModule(feeModuleProxyAddress, nm.override());
  await setFeeModuleTx1.wait();
  console.log(`   PrivacyPool.setFeeModule() done`);

  // 4. Wire fee module into ArmadaYieldVault
  console.log("--- Wiring fee module into ArmadaYieldVault ---");
  const yieldVault = await ethers.getContractAt("ArmadaYieldVault", yieldVaultAddress);
  const setFeeModuleTx2 = await yieldVault.setFeeModule(feeModuleProxyAddress, nm.override());
  await setFeeModuleTx2.wait();
  console.log(`   ArmadaYieldVault.setFeeModule() done`);

  // 5. Update RevenueCounter to use fee module as fee collector
  if (revenueCounterAddress) {
    console.log("--- Updating RevenueCounter fee collector ---");
    const revenueCounter = await ethers.getContractAt("RevenueCounter", revenueCounterAddress);
    const setCollectorTx = await revenueCounter.setFeeCollector(feeModuleProxyAddress, nm.override());
    await setCollectorTx.wait();
    console.log(`   RevenueCounter.setFeeCollector() done`);
  }

  // 6. Register extended selectors on governor (local only — testnet uses governance proposals)
  if (!isSepolia && governorAddress) {
    console.log("--- Registering extended selectors on ArmadaGovernor ---");
    const governor = await ethers.getContractAt("ArmadaGovernor", governorAddress);
    for (const sig of FEE_MODULE_EXTENDED_SELECTORS) {
      const selector = ethers.id(sig).slice(0, 10);
      const tx = await governor.addExtendedSelector(selector, nm.override());
      await tx.wait();
      console.log(`   Registered: ${sig} → ${selector}`);
    }
  }

  // 7. Save to deployment manifest
  const feeModuleDeployment = {
    feeModuleImpl: feeModuleImplAddress,
    feeModuleProxy: feeModuleProxyAddress,
    owner: ownerAddress,
    treasury: treasuryAddress,
    privacyPool: privacyPoolAddress,
    yieldVault: yieldVaultAddress,
    chainId,
    deployedAt: new Date().toISOString(),
  };

  const feeFile = isSepolia ? "fee-module-sepolia.json" : "fee-module.json";
  saveDeployment(feeFile, feeModuleDeployment);
  console.log(`\nDeployment saved to deployments/${feeFile}`);
  console.log("=== ArmadaFeeModule deployment complete ===\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
