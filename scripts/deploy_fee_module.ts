// ABOUTME: Deployment script for ArmadaFeeModule (UUPS proxy) and wiring to PrivacyPool, YieldVault, and RevenueCounter.
// ABOUTME: Transfers yield contract ownership to timelock after all owner-gated configuration is complete.

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
 * - RevenueCounter.setFeeCollector(feeModuleProxy) — timelock-only, uses impersonation on local
 * - Transfer yield contract ownership to timelock
 *
 * Fee module extended selectors are hardcoded in ArmadaGovernor.initialize().
 *
 * Prerequisites: Governance, PrivacyPool, and YieldVault must be deployed.
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_fee_module.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_fee_module.ts --network sepoliaHub
 */

import { ethers } from "hardhat";
import {
  getGovernanceDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  isLocal,
} from "../config/networks";
import { createNonceManager, loadDeployment, saveDeployment, timelockCall } from "./deploy-utils";

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const [deployer] = await ethers.getSigners();
  const nm = await createNonceManager(deployer);

  console.log(`\n=== Deploying ArmadaFeeModule on chain ${chainId} ===`);
  console.log(`Deployer: ${deployer.address}`);

  // Load existing deployments using canonical helpers
  const poolDeployment = loadDeployment(getPrivacyPoolDeploymentFile("hub"));
  const yieldDeployment = loadDeployment(getYieldDeploymentFile());
  const govDeployment = loadDeployment(getGovernanceDeploymentFile());

  if (!poolDeployment) throw new Error(`Privacy pool deployment not found. Deploy privacy pool first.`);
  if (!yieldDeployment) throw new Error(`Yield deployment not found. Deploy yield contracts first.`);
  if (!govDeployment) throw new Error(`Governance deployment not found. Deploy governance first.`);

  const privacyPoolAddress = poolDeployment.contracts.privacyPool;
  const yieldVaultAddress = yieldDeployment.contracts.armadaYieldVault;
  const treasuryAddress = govDeployment.contracts.treasury;
  const timelockAddress = govDeployment.contracts.timelockController;
  const governorAddress = govDeployment.contracts.governor;
  const revenueCounterAddress = govDeployment.contracts.revenueCounter;

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
  // For local dev: owner = deployer (direct control). For non-local: owner = timelock.
  const ownerAddress = isLocal() ? deployer.address : timelockAddress;

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

  // 3. Wire fee module into PrivacyPool (owner-gated — deployer is pool owner)
  console.log("\n--- Wiring fee module into PrivacyPool ---");
  const privacyPool = await ethers.getContractAt("PrivacyPool", privacyPoolAddress);
  const setFeeModuleTx1 = await privacyPool.setFeeModule(feeModuleProxyAddress, nm.override());
  await setFeeModuleTx1.wait();
  console.log(`   PrivacyPool.setFeeModule() done`);

  // 4. Wire fee module into ArmadaYieldVault (owner-gated — deployer is vault owner)
  console.log("--- Wiring fee module into ArmadaYieldVault ---");
  const yieldVault = await ethers.getContractAt("ArmadaYieldVault", yieldVaultAddress);
  const setFeeModuleTx2 = await yieldVault.setFeeModule(feeModuleProxyAddress, nm.override());
  await setFeeModuleTx2.wait();
  console.log(`   ArmadaYieldVault.setFeeModule() done`);

  // 5. Update RevenueCounter to use fee module as fee collector (timelock-only)
  if (revenueCounterAddress) {
    console.log("--- Updating RevenueCounter fee collector ---");
    const revenueCounter = await ethers.getContractAt("RevenueCounter", revenueCounterAddress);
    const setCollectorCalldata = revenueCounter.interface.encodeFunctionData(
      "setFeeCollector", [feeModuleProxyAddress]
    );
    await timelockCall(
      timelockAddress, revenueCounterAddress, setCollectorCalldata,
      "RevenueCounter.setFeeCollector()", nm
    );
  }

  // Fee module extended selectors (setBaseArmadaTake, addTier, etc.) are hardcoded
  // in ArmadaGovernor.initialize() — no runtime registration needed.

  // 6. Transfer yield contract ownership to timelock (all owner-gated config complete)
  console.log("\n--- Transferring yield contract ownership to timelock ---");
  const armadaTreasury = await ethers.getContractAt("Ownable", yieldDeployment.contracts.armadaTreasury);
  const armadaYieldAdapter = await ethers.getContractAt("Ownable", yieldDeployment.contracts.armadaYieldAdapter);
  await (await armadaTreasury.transferOwnership(timelockAddress, nm.override())).wait();
  console.log(`   ArmadaTreasury owner → ${timelockAddress}`);
  await (await yieldVault.transferOwnership(timelockAddress, nm.override())).wait();
  console.log(`   ArmadaYieldVault owner → ${timelockAddress}`);
  await (await armadaYieldAdapter.transferOwnership(timelockAddress, nm.override())).wait();
  console.log(`   ArmadaYieldAdapter owner → ${timelockAddress}`);

  // 7. Save to deployment manifest
  const suffix = isLocal() ? "" : `-${network.name}`;
  const feeFile = `fee-module-hub${suffix}.json`;
  const feeModuleDeployment = {
    chainId,
    deployer: deployer.address,
    contracts: {
      feeModuleImpl: feeModuleImplAddress,
      feeModuleProxy: feeModuleProxyAddress,
    },
    config: {
      owner: ownerAddress,
      treasury: treasuryAddress,
      privacyPool: privacyPoolAddress,
      yieldVault: yieldVaultAddress,
    },
    timestamp: new Date().toISOString(),
  };

  saveDeployment(feeFile, feeModuleDeployment);
  console.log(`\nDeployment saved to deployments/${feeFile}`);
  console.log("=== ArmadaFeeModule deployment complete ===\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
