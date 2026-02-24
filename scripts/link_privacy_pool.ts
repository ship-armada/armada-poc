/**
 * Link Privacy Pool Deployments
 *
 * This script links the Hub PrivacyPool with Client PrivacyPoolClients:
 *   - Sets remote pool addresses on Hub for each client domain
 *   - Updates client deployments with hub pool address
 *   - Configures CCTP TokenMessenger remote addresses
 *
 * Prerequisites:
 *   - CCTP V2 contracts deployed on all chains
 *   - Privacy Pool contracts deployed on all chains
 *
 * Usage:
 *   npx hardhat run scripts/link_privacy_pool.ts --network hub
 *
 * Note: Run this on the Hub chain after all deployments are complete.
 */

import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Domain IDs (matching CCTPDomains library)
const DOMAINS = {
  hub: 100,
  client: 101,
  clientB: 102,
};

interface LinkConfig {
  domain: number;
  deploymentFile: string;
  cctpFile: string;
  name: string;
}

const CLIENT_CONFIGS: LinkConfig[] = [
  {
    domain: DOMAINS.client,
    deploymentFile: "privacy-pool-client.json",
    cctpFile: "client-v3.json",
    name: "Client A",
  },
  {
    domain: DOMAINS.clientB,
    deploymentFile: "privacy-pool-clientB.json",
    cctpFile: "clientB-v3.json",
    name: "Client B",
  },
];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("=== Linking Privacy Pool Deployments ===");
  console.log(`Signer: ${signer.address}`);
  console.log("");

  // Load Hub deployment
  const hubDeployment = loadDeployment("privacy-pool-hub.json");
  if (!hubDeployment) {
    throw new Error("Hub deployment not found. Run deploy_privacy_pool.ts on hub first.");
  }

  const hubPoolAddress = hubDeployment.contracts.privacyPool;
  console.log(`Hub PrivacyPool: ${hubPoolAddress}`);

  // Get PrivacyPool contract instance
  const privacyPool = await ethers.getContractAt("PrivacyPool", hubPoolAddress);

  // Load Hub CCTP deployment for TokenMessenger configuration
  const hubCctp = loadDeployment("hub-v3.json");
  if (!hubCctp) {
    throw new Error("Hub CCTP deployment not found.");
  }

  const hubTokenMessenger = await ethers.getContractAt(
    "MockTokenMessengerV2",
    hubCctp.contracts.tokenMessenger
  );

  console.log("");
  console.log("Linking clients to Hub...");
  console.log("");

  // Process each client
  for (const config of CLIENT_CONFIGS) {
    console.log(`--- ${config.name} (Domain ${config.domain}) ---`);

    // Load client privacy pool deployment
    const clientDeployment = loadDeployment(config.deploymentFile);
    if (!clientDeployment) {
      console.log(`  Warning: ${config.name} deployment not found, skipping`);
      continue;
    }

    const clientAddress = clientDeployment.contracts.privacyPoolClient;
    const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);
    console.log(`  PrivacyPoolClient: ${clientAddress}`);

    // Set remote pool on Hub
    console.log(`  Setting remote pool on Hub...`);
    const setRemoteTx = await privacyPool.setRemotePool(config.domain, clientBytes32);
    await setRemoteTx.wait();
    console.log(`  ✓ Remote pool set for domain ${config.domain}`);

    // Load client CCTP deployment for TokenMessenger linking
    const clientCctp = loadDeployment(config.cctpFile);
    if (clientCctp) {
      // Set remote TokenMessenger on Hub TokenMessenger (Hub -> Client)
      const clientTokenMessengerBytes32 = ethers.zeroPadValue(
        clientCctp.contracts.tokenMessenger,
        32
      );
      console.log(`  Setting remote TokenMessenger on Hub...`);
      const setRemoteMessengerTx = await hubTokenMessenger.setRemoteTokenMessenger(
        config.domain,
        clientTokenMessengerBytes32
      );
      await setRemoteMessengerTx.wait();
      console.log(`  ✓ Remote TokenMessenger set for domain ${config.domain}`);
    }

    console.log("");
  }

  // IMPORTANT: Configure Client TokenMessengers to know about Hub TokenMessenger
  // This is needed for Client -> Hub messages (cross-chain shields)
  const hubTokenMessengerBytes32 = ethers.zeroPadValue(
    hubCctp.contracts.tokenMessenger,
    32
  );

  console.log("Configuring Client TokenMessengers with Hub address...");
  console.log("");

  for (const config of CLIENT_CONFIGS) {
    const clientCctp = loadDeployment(config.cctpFile);
    if (!clientCctp) continue;

    // Connect to client chain
    const clientRpc = config.domain === DOMAINS.client
      ? process.env.CLIENT_RPC || "http://localhost:8546"
      : process.env.CLIENT_B_RPC || "http://localhost:8547";

    const clientProvider = new ethers.JsonRpcProvider(clientRpc);
    const clientSigner = new ethers.Wallet(
      process.env.DEPLOYER_PRIVATE_KEY!,
      clientProvider
    );

    const clientTokenMessenger = new ethers.Contract(
      clientCctp.contracts.tokenMessenger,
      ["function setRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external"],
      clientSigner
    );

    console.log(`  Setting Hub TokenMessenger on ${config.name}...`);
    const tx = await clientTokenMessenger.setRemoteTokenMessenger(
      DOMAINS.hub,
      hubTokenMessengerBytes32
    );
    await tx.wait();
    console.log(`  ✓ Hub TokenMessenger set on ${config.name}`);
  }

  console.log("");

  // Set Hub TokenMessenger as remote on Hub (for local operations, if needed)
  await hubTokenMessenger.setRemoteTokenMessenger(DOMAINS.hub, hubTokenMessengerBytes32);
  console.log(`✓ Hub TokenMessenger self-reference set`);

  // Configure ArmadaYieldAdapter if yield is deployed
  const yieldDeployment = loadDeployment("yield-hub.json");
  if (yieldDeployment?.contracts?.armadaYieldAdapter) {
    const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter;
    console.log("");
    console.log("Configuring ArmadaYieldAdapter...");
    const adapter = await ethers.getContractAt("ArmadaYieldAdapter", adapterAddress);
    await (await adapter.setPrivacyPool(hubPoolAddress)).wait();
    console.log(`  ✓ Adapter privacy pool set to: ${hubPoolAddress}`);
    await (await privacyPool.setPrivilegedShieldCaller(adapterAddress, true)).wait();
    console.log(`  ✓ Adapter set as privileged shield caller (fee exemption)`);
  }

  console.log("");
  console.log("=== Linking Complete ===");
  console.log("");
  console.log("Summary:");
  console.log(`  Hub PrivacyPool: ${hubPoolAddress}`);

  // Verify remote pools
  for (const config of CLIENT_CONFIGS) {
    const remotePool = await privacyPool.remotePools(config.domain);
    console.log(`  ${config.name} (Domain ${config.domain}): ${remotePool}`);
  }
}

function loadDeployment(filename: string): any | null {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
