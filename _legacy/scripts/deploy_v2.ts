/**
 * Deploy V2 Contracts for Railgun Integration
 *
 * This script deploys the V2 contracts that work with RailgunSmartWallet:
 * - ClientShieldProxyV2 (on client chain)
 * - HubCCTPReceiverV2 (on hub chain)
 *
 * Prerequisites:
 * - Railgun contracts must already be deployed (run deploy:railgun first)
 * - MockUSDC contracts must already be deployed (run deploy:all first)
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");

interface Deployment {
  chainId: number;
  contracts: {
    [key: string]: string;
  };
}

function loadDeployment(name: string): Deployment {
  const filePath = path.join(DEPLOYMENTS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Deployment file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveDeployment(name: string, deployment: Deployment): void {
  const filePath = path.join(DEPLOYMENTS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("=== Deploying V2 Contracts ===");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log("");

  // Determine which chain we're on
  // Hub uses 31337 to match Railgun SDK's Hardhat network config
  const isHubChain = chainId === 31337;
  const isClientChainA = chainId === 31338;
  const isClientChainB = chainId === 31339;
  const isClientChain = isClientChainA || isClientChainB;

  if (!isClientChain && !isHubChain) {
    throw new Error(`Unknown chain ID: ${chainId}. Expected 31337 (hub), 31338 (client A), or 31339 (client B)`);
  }

  if (isHubChain) {
    // Deploy HubCCTPReceiverV2 on hub chain
    console.log("Deploying HubCCTPReceiverV2 on Hub Chain...");

    // Load required deployments
    const hubDeployment = loadDeployment("hub");
    const railgunDeployment = loadDeployment("railgun");

    const mockUSDC = hubDeployment.contracts.mockUSDC;
    const railgunProxy = railgunDeployment.contracts.railgunProxy;

    console.log(`  MockUSDC: ${mockUSDC}`);
    console.log(`  RailgunSmartWallet: ${railgunProxy}`);

    const HubCCTPReceiverV2 = await ethers.getContractFactory("HubCCTPReceiverV2");
    const receiver = await HubCCTPReceiverV2.deploy(mockUSDC, railgunProxy);
    await receiver.waitForDeployment();
    const receiverAddress = await receiver.getAddress();

    console.log(`  HubCCTPReceiverV2: ${receiverAddress}`);

    // Update hub deployment
    hubDeployment.contracts.hubCCTPReceiverV2 = receiverAddress;
    hubDeployment.contracts.railgunProxy = railgunProxy;
    saveDeployment("hub", hubDeployment);

    // Update MockUSDC to use new receiver as callback
    console.log("\nUpdating MockUSDC callback recipient...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDCContract = MockUSDC.attach(mockUSDC);

    // Check if there's a setCallback function, if not we need to redeploy or update differently
    // For now, the receiver address is passed in the burn payload, so no change needed

    console.log("\n=== Hub V2 Deployment Complete ===");
    console.log(`HubCCTPReceiverV2: ${receiverAddress}`);

  } else if (isClientChain) {
    // Deploy ClientShieldProxyV2 on client chain (A or B)
    const chainName = isClientChainA ? "Client A" : "Client B";
    const deploymentName = isClientChainA ? "client" : "clientB";

    console.log(`Deploying ClientShieldProxyV2 on ${chainName}...`);

    // Load required deployments
    const clientDeployment = loadDeployment(deploymentName);
    const hubDeployment = loadDeployment("hub");

    const mockUSDC = clientDeployment.contracts.mockUSDC;
    const hubCCTPReceiverV2 = hubDeployment.contracts.hubCCTPReceiverV2;

    if (!hubCCTPReceiverV2) {
      throw new Error("HubCCTPReceiverV2 not found. Deploy on hub chain first.");
    }

    const hubChainId = 31337;

    console.log(`  MockUSDC: ${mockUSDC}`);
    console.log(`  Hub Chain ID: ${hubChainId}`);
    console.log(`  HubCCTPReceiverV2: ${hubCCTPReceiverV2}`);

    const ClientShieldProxyV2 = await ethers.getContractFactory("ClientShieldProxyV2");
    const proxy = await ClientShieldProxyV2.deploy(mockUSDC, hubChainId, hubCCTPReceiverV2);
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();

    console.log(`  ClientShieldProxyV2: ${proxyAddress}`);

    // Update client deployment
    clientDeployment.contracts.clientShieldProxyV2 = proxyAddress;
    saveDeployment(deploymentName, clientDeployment);

    console.log(`\n=== ${chainName} V2 Deployment Complete ===`);
    console.log(`ClientShieldProxyV2: ${proxyAddress}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
