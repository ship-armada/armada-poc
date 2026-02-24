/**
 * Deploy Privacy Pool Modular Architecture
 *
 * This script deploys the new modular privacy pool system:
 *   Hub Chain:
 *     - PrivacyPool (router)
 *     - MerkleModule, VerifierModule, ShieldModule, TransactModule
 *
 *   Client Chain:
 *     - PrivacyPoolClient
 *
 * Prerequisites:
 *   - CCTP V2 contracts must be deployed/configured
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network hub
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network client
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network clientB
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaHub
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaClientA
 *   npx hardhat run scripts/deploy_privacy_pool.ts --network sepoliaClientB
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getChainRole,
  getCCTPDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  type ChainRole,
} from "../config/networks";
import { createNonceManager } from "./deploy-utils";

// Load Poseidon bytecode for library deployment
const poseidonBytecode = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "lib", "poseidon_bytecode.json"), "utf-8")
);

interface HubDeploymentInfo {
  chainId: number;
  domain: number;
  deployer: string;
  contracts: {
    privacyPool: string;
    merkleModule: string;
    verifierModule: string;
    shieldModule: string;
    transactModule: string;
  };
  cctp: {
    tokenMessenger: string;
    messageTransmitter: string;
    usdc: string;
  };
  timestamp: string;
}

interface ClientDeploymentInfo {
  chainId: number;
  domain: number;
  deployer: string;
  contracts: {
    privacyPoolClient: string;
  };
  cctp: {
    tokenMessenger: string;
    messageTransmitter: string;
    usdc: string;
  };
  hub: {
    domain: number;
    privacyPool: string;
  };
  timestamp: string;
}

async function deployHub(): Promise<HubDeploymentInfo> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const domain = config.hub.cctpDomain;
  const nm = await createNonceManager(deployer);

  console.log("=== Deploying Privacy Pool Modules to Hub Chain ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`CCTP Domain: ${domain}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // Load CCTP deployment
  const cctpFilename = getCCTPDeploymentFile("hub");
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    throw new Error(`CCTP deployment not found (${cctpFilename}). Run deploy_cctp first.`);
  }

  const usdcAddress = cctpDeployment.contracts.usdc;
  const tokenMessengerAddress = cctpDeployment.contracts.tokenMessenger;
  const messageTransmitterAddress = cctpDeployment.contracts.messageTransmitter;

  console.log("CCTP Contracts:");
  console.log(`  USDC: ${usdcAddress}`);
  console.log(`  TokenMessenger: ${tokenMessengerAddress}`);
  console.log(`  MessageTransmitter: ${messageTransmitterAddress}`);
  console.log("");

  // 1. Deploy Poseidon libraries
  console.log("1. Deploying Poseidon libraries...");
  const poseidonT3Tx = await deployer.sendTransaction({
    data: poseidonBytecode.PoseidonT3.bytecode,
    ...nm.override(),
  });
  const poseidonT3Receipt = await poseidonT3Tx.wait();
  const poseidonT3Address = poseidonT3Receipt!.contractAddress!;
  console.log(`   PoseidonT3: ${poseidonT3Address}`);

  const poseidonT4Tx = await deployer.sendTransaction({
    data: poseidonBytecode.PoseidonT4.bytecode,
    ...nm.override(),
  });
  const poseidonT4Receipt = await poseidonT4Tx.wait();
  const poseidonT4Address = poseidonT4Receipt!.contractAddress!;
  console.log(`   PoseidonT4: ${poseidonT4Address}`);

  // 2. Deploy MerkleModule (requires PoseidonT3)
  console.log("\n2. Deploying MerkleModule...");
  const MerkleModule = await ethers.getContractFactory("MerkleModule", {
    libraries: { PoseidonT3: poseidonT3Address },
  });
  const merkleModule = await MerkleModule.deploy(nm.override());
  await merkleModule.deploymentTransaction()!.wait();
  const merkleModuleAddress = await merkleModule.getAddress();
  console.log(`   MerkleModule: ${merkleModuleAddress}`);

  // 3. Deploy VerifierModule
  console.log("\n3. Deploying VerifierModule...");
  const VerifierModule = await ethers.getContractFactory("VerifierModule");
  const verifierModule = await VerifierModule.deploy(nm.override());
  await verifierModule.deploymentTransaction()!.wait();
  const verifierModuleAddress = await verifierModule.getAddress();
  console.log(`   VerifierModule: ${verifierModuleAddress}`);

  // 4. Deploy ShieldModule (requires PoseidonT4)
  console.log("\n4. Deploying ShieldModule...");
  const ShieldModule = await ethers.getContractFactory("ShieldModule", {
    libraries: { PoseidonT4: poseidonT4Address },
  });
  const shieldModule = await ShieldModule.deploy(nm.override());
  await shieldModule.deploymentTransaction()!.wait();
  const shieldModuleAddress = await shieldModule.getAddress();
  console.log(`   ShieldModule: ${shieldModuleAddress}`);

  // 5. Deploy TransactModule (requires PoseidonT4)
  console.log("\n5. Deploying TransactModule...");
  const TransactModule = await ethers.getContractFactory("TransactModule", {
    libraries: { PoseidonT4: poseidonT4Address },
  });
  const transactModule = await TransactModule.deploy(nm.override());
  await transactModule.deploymentTransaction()!.wait();
  const transactModuleAddress = await transactModule.getAddress();
  console.log(`   TransactModule: ${transactModuleAddress}`);

  // 6. Deploy PrivacyPool (router)
  console.log("\n6. Deploying PrivacyPool (router)...");
  const PrivacyPool = await ethers.getContractFactory("PrivacyPool");
  const privacyPool = await PrivacyPool.deploy(nm.override());
  await privacyPool.deploymentTransaction()!.wait();
  const privacyPoolAddress = await privacyPool.getAddress();
  console.log(`   PrivacyPool: ${privacyPoolAddress}`);

  // 7. Initialize PrivacyPool
  console.log("\n7. Initializing PrivacyPool...");
  const initTx = await privacyPool.initialize(
    shieldModuleAddress,
    transactModuleAddress,
    merkleModuleAddress,
    verifierModuleAddress,
    tokenMessengerAddress,
    messageTransmitterAddress,
    usdcAddress,
    domain,
    deployer.address,
    nm.override()
  );
  await initTx.wait();
  console.log("   PrivacyPool initialized");

  // 8. Load verification keys for SNARK proof verification
  console.log("\n8. Loading verification keys...");
  const { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } = await import("../lib/artifacts");
  await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, true);

  // 9. SNARK verification enabled
  console.log("\n9. SNARK verification enabled (testing mode disabled)");

  // 9b. Configure shield fee and treasury
  console.log("\n9b. Configuring shield fee...");
  const yieldDeployment = loadDeployment(getYieldDeploymentFile());
  let treasuryAddress = deployer.address;
  if (config.treasuryAddress) {
    treasuryAddress = config.treasuryAddress;
    console.log("   Using TREASURY_ADDRESS from env");
  } else if (yieldDeployment?.contracts?.armadaTreasury) {
    treasuryAddress = yieldDeployment.contracts.armadaTreasury;
    console.log("   Using ArmadaTreasury from yield deployment");
  } else {
    console.log("   Warning: no treasury configured, using deployer as treasury");
  }
  await (await privacyPool.setTreasury(treasuryAddress)).wait();
  await (await privacyPool.setShieldFee(50)).wait();
  console.log("   Treasury: " + treasuryAddress);
  console.log("   Shield fee: 50 bps (0.50%)");

  const deployment: HubDeploymentInfo = {
    chainId,
    domain,
    deployer: deployer.address,
    contracts: {
      privacyPool: privacyPoolAddress,
      merkleModule: merkleModuleAddress,
      verifierModule: verifierModuleAddress,
      shieldModule: shieldModuleAddress,
      transactModule: transactModuleAddress,
    },
    cctp: {
      tokenMessenger: tokenMessengerAddress,
      messageTransmitter: messageTransmitterAddress,
      usdc: usdcAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const filename = getPrivacyPoolDeploymentFile("hub");
  saveDeployment(filename, deployment);

  console.log("\n=== Hub Privacy Pool Deployment Complete ===");
  console.log(`Deployment saved to: deployments/${filename}`);

  return deployment;
}

async function deployClient(role: ChainRole): Promise<ClientDeploymentInfo> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const chain = role === "clientA" ? config.clientA : config.clientB;
  const domain = chain.cctpDomain;
  const name = chain.name;
  const nm = await createNonceManager(deployer);

  console.log(`=== Deploying PrivacyPoolClient to ${name} Chain ===`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`CCTP Domain: ${domain}`);
  console.log(`Environment: ${config.env}`);
  console.log("");

  // Load CCTP deployment for this chain
  const cctpFilename = getCCTPDeploymentFile(role);
  const cctpDeployment = loadDeployment(cctpFilename);
  if (!cctpDeployment) {
    throw new Error(`CCTP deployment not found (${cctpFilename}). Run deploy_cctp first.`);
  }

  const usdcAddress = cctpDeployment.contracts.usdc;
  const tokenMessengerAddress = cctpDeployment.contracts.tokenMessenger;
  const messageTransmitterAddress = cctpDeployment.contracts.messageTransmitter;

  console.log("CCTP Contracts:");
  console.log(`  USDC: ${usdcAddress}`);
  console.log(`  TokenMessenger: ${tokenMessengerAddress}`);
  console.log(`  MessageTransmitter: ${messageTransmitterAddress}`);
  console.log("");

  // Load Hub deployment
  const hubFilename = getPrivacyPoolDeploymentFile("hub");
  const hubDeployment = loadDeployment(hubFilename);
  let hubPoolAddress = ethers.ZeroAddress;
  let hubPoolBytes32 = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const hubDomain = config.hub.cctpDomain;

  if (hubDeployment) {
    hubPoolAddress = hubDeployment.contracts.privacyPool;
    hubPoolBytes32 = ethers.zeroPadValue(hubPoolAddress, 32);
    console.log(`Hub PrivacyPool: ${hubPoolAddress}`);
  } else {
    console.log("Warning: Hub deployment not found, will need to link later");
  }
  console.log("");

  // 1. Deploy PrivacyPoolClient
  console.log("1. Deploying PrivacyPoolClient...");
  const PrivacyPoolClient = await ethers.getContractFactory("PrivacyPoolClient");
  const privacyPoolClient = await PrivacyPoolClient.deploy(nm.override());
  await privacyPoolClient.deploymentTransaction()!.wait();
  const clientAddress = await privacyPoolClient.getAddress();
  console.log(`   PrivacyPoolClient: ${clientAddress}`);

  // 2. Initialize PrivacyPoolClient
  console.log("\n2. Initializing PrivacyPoolClient...");
  const initTx = await privacyPoolClient.initialize(
    tokenMessengerAddress,
    messageTransmitterAddress,
    usdcAddress,
    domain,
    hubDomain,
    hubPoolBytes32,
    deployer.address,
    nm.override()
  );
  await initTx.wait();
  console.log("   PrivacyPoolClient initialized");

  const deployment: ClientDeploymentInfo = {
    chainId,
    domain,
    deployer: deployer.address,
    contracts: {
      privacyPoolClient: clientAddress,
    },
    cctp: {
      tokenMessenger: tokenMessengerAddress,
      messageTransmitter: messageTransmitterAddress,
      usdc: usdcAddress,
    },
    hub: {
      domain: hubDomain,
      privacyPool: hubPoolAddress,
    },
    timestamp: new Date().toISOString(),
  };

  const filename = getPrivacyPoolDeploymentFile(role);
  saveDeployment(filename, deployment);

  console.log(`\n=== ${name} PrivacyPoolClient Deployment Complete ===`);
  console.log(`Deployment saved to: deployments/${filename}`);

  return deployment;
}

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
  const config = getNetworkConfig();

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    console.error(`Configured chains: hub=${config.hub.chainId}, clientA=${config.clientA.chainId}, clientB=${config.clientB.chainId}`);
    process.exit(1);
  }

  if (role === "hub") {
    await deployHub();
  } else {
    await deployClient(role);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
