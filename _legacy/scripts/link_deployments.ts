import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Link deployments between Client chains and Hub chain
 *
 * Run AFTER all deploy scripts have completed.
 *
 * This script:
 * 1. Reads deployment info from hub and the current client chain
 * 2. Sets hubReceiverV2 on ClientShieldProxyV2 (client chain)
 *
 * Supports both Client A (31338) and Client B (31339)
 * Note: Hub uses 31337 to match Railgun SDK's Hardhat network config
 */

async function main() {
  // Connect to current chain
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  // Determine which client chain we're on
  const isClientChainA = chainId === 31338;
  const isClientChainB = chainId === 31339;

  if (!isClientChainA && !isClientChainB) {
    console.error(`ERROR: Must run on a client network (31338 or 31339). Current chain: ${chainId}`);
    console.error("Use --network client or --network clientB");
    process.exit(1);
  }

  const chainName = isClientChainA ? "Client A" : "Client B";
  const deploymentName = isClientChainA ? "client" : "clientB";

  console.log(`=== Linking ${chainName} to Hub ===\n`);

  // Load deployment info
  const deploymentsDir = path.join(__dirname, "../deployments");

  const hubDeploymentPath = path.join(deploymentsDir, "hub.json");
  const clientDeploymentPath = path.join(deploymentsDir, `${deploymentName}.json`);

  if (!fs.existsSync(hubDeploymentPath)) {
    console.error("ERROR: Hub deployment not found. Run 'npm run deploy:hub' first.");
    process.exit(1);
  }

  if (!fs.existsSync(clientDeploymentPath)) {
    console.error(`ERROR: ${chainName} deployment not found. Run 'npm run deploy:${isClientChainA ? "client" : "clientB"}' first.`);
    process.exit(1);
  }

  const hubDeployment = JSON.parse(fs.readFileSync(hubDeploymentPath, "utf-8"));
  const clientDeployment = JSON.parse(fs.readFileSync(clientDeploymentPath, "utf-8"));

  // Check for V2 contracts
  if (!hubDeployment.contracts.hubCCTPReceiverV2) {
    console.error("ERROR: HubCCTPReceiverV2 not found. Run 'npm run deploy:v2:hub' first.");
    process.exit(1);
  }

  if (!clientDeployment.contracts.clientShieldProxyV2) {
    console.error(`ERROR: ClientShieldProxyV2 not found on ${chainName}. Run 'npm run deploy:v2:${isClientChainA ? "client" : "clientB"}' first.`);
    process.exit(1);
  }

  console.log("Hub deployment:");
  console.log(`  HubCCTPReceiverV2: ${hubDeployment.contracts.hubCCTPReceiverV2}`);
  console.log(`\n${chainName} deployment:`);
  console.log(`  ClientShieldProxyV2: ${clientDeployment.contracts.clientShieldProxyV2}`);

  console.log(`\nConnected to chain ${network.chainId} as ${deployer.address}`);

  // Get ClientShieldProxyV2 contract
  const ClientShieldProxyV2 = await ethers.getContractFactory("ClientShieldProxyV2");
  const clientShieldProxyV2 = ClientShieldProxyV2.attach(clientDeployment.contracts.clientShieldProxyV2);

  // Check current hubReceiver
  const currentHubReceiver = await clientShieldProxyV2.hubReceiver();
  console.log(`\nCurrent hubReceiver: ${currentHubReceiver}`);

  if (currentHubReceiver === hubDeployment.contracts.hubCCTPReceiverV2) {
    console.log("Already configured correctly!");
  } else {
    // Set hubReceiver
    console.log(`\nSetting hubReceiver to: ${hubDeployment.contracts.hubCCTPReceiverV2}`);
    const tx = await clientShieldProxyV2.setHubReceiver(hubDeployment.contracts.hubCCTPReceiverV2);
    await tx.wait();

    // Verify
    const newHubReceiver = await clientShieldProxyV2.hubReceiver();
    console.log(`New hubReceiver: ${newHubReceiver}`);

    if (newHubReceiver !== hubDeployment.contracts.hubCCTPReceiverV2) {
      console.error("\nERROR: hubReceiver not set correctly!");
      process.exit(1);
    }
  }

  console.log(`\n=== ${chainName} Linking Complete ===`);
  console.log("\nDeployments are now connected!");
  console.log(`All addresses are stored in deployments/${deploymentName}.json`);
  console.log("\nNext steps:");
  console.log("  1. Start the relayer:  npm run relayer");
  console.log("  2. Run tests:          npm run test:all");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
