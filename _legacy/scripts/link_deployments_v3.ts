/**
 * Link CCTP V2 Deployments
 *
 * After deploying to all chains, this script:
 *   1. Sets remote TokenMessenger addresses on each chain
 *   2. Updates ClientShieldProxy with correct HubCCTPReceiver address
 *   3. Mints initial USDC to test accounts
 *
 * Usage:
 *   npx hardhat run scripts/link_deployments_v3.ts --network hub
 *   (Run once after all chains are deployed)
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Anvil default deployer private key
const DEPLOYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Domain IDs
const DOMAINS = {
  hub: 100,
  client: 101,
  clientB: 102,
};

interface DeploymentInfo {
  chainId: number;
  domain: number;
  contracts: {
    usdc: string;
    messageTransmitter: string;
    tokenMessenger: string;
    hubCCTPReceiver?: string;
    hubUnshieldProxy?: string;
    clientShieldProxy?: string;
  };
}

// ABIs for linking
const TOKEN_MESSENGER_ABI = [
  "function setRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external",
];

const CLIENT_SHIELD_PROXY_ABI = [
  "function setHubReceiver(address _hubReceiver) external",
];

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
];

function loadDeployment(filename: string): DeploymentInfo | null {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const filePath = path.join(deploymentsDir, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

async function linkHubToClients(
  hubDeployment: DeploymentInfo,
  clientDeployment: DeploymentInfo,
  clientBDeployment: DeploymentInfo,
  deployer: ethers.Signer
) {
  console.log("=== Linking Hub to Client Chains ===\n");

  const tokenMessenger = new ethers.Contract(
    hubDeployment.contracts.tokenMessenger,
    TOKEN_MESSENGER_ABI,
    deployer
  );

  // Set Client A's TokenMessenger
  console.log("Setting Client A TokenMessenger on Hub...");
  await (
    await tokenMessenger.setRemoteTokenMessenger(
      DOMAINS.client,
      ethers.zeroPadValue(clientDeployment.contracts.tokenMessenger, 32)
    )
  ).wait();
  console.log(`  Domain ${DOMAINS.client} → ${clientDeployment.contracts.tokenMessenger}`);

  // Set Client B's TokenMessenger
  console.log("\nSetting Client B TokenMessenger on Hub...");
  await (
    await tokenMessenger.setRemoteTokenMessenger(
      DOMAINS.clientB,
      ethers.zeroPadValue(clientBDeployment.contracts.tokenMessenger, 32)
    )
  ).wait();
  console.log(`  Domain ${DOMAINS.clientB} → ${clientBDeployment.contracts.tokenMessenger}`);
}

async function linkClientToHub(
  clientDeployment: DeploymentInfo,
  hubDeployment: DeploymentInfo,
  rpcUrl: string,
  clientName: string
) {
  console.log(`\n=== Linking ${clientName} to Hub ===\n`);

  // Connect to client chain with hardcoded Anvil key
  const clientProvider = new ethers.JsonRpcProvider(rpcUrl);
  const clientDeployer = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, clientProvider);

  // Set Hub's TokenMessenger on client
  const tokenMessenger = new ethers.Contract(
    clientDeployment.contracts.tokenMessenger,
    TOKEN_MESSENGER_ABI,
    clientDeployer
  );

  console.log("Setting Hub TokenMessenger on client...");
  await (
    await tokenMessenger.setRemoteTokenMessenger(
      DOMAINS.hub,
      ethers.zeroPadValue(hubDeployment.contracts.tokenMessenger, 32)
    )
  ).wait();
  console.log(`  Domain ${DOMAINS.hub} → ${hubDeployment.contracts.tokenMessenger}`);

  // Update ClientShieldProxy with HubCCTPReceiver address
  if (clientDeployment.contracts.clientShieldProxy && hubDeployment.contracts.hubCCTPReceiver) {
    const clientShieldProxy = new ethers.Contract(
      clientDeployment.contracts.clientShieldProxy,
      CLIENT_SHIELD_PROXY_ABI,
      clientDeployer
    );

    console.log("\nUpdating ClientShieldProxy hub receiver...");
    await (await clientShieldProxy.setHubReceiver(hubDeployment.contracts.hubCCTPReceiver)).wait();
    console.log(`  HubReceiver → ${hubDeployment.contracts.hubCCTPReceiver}`);
  }
}

async function mintInitialUSDC(
  deployment: DeploymentInfo,
  rpcUrl: string,
  chainName: string
) {
  console.log(`\n=== Minting Initial USDC on ${chainName} ===\n`);

  const chainProvider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, chainProvider);

  const usdc = new ethers.Contract(deployment.contracts.usdc, USDC_ABI, signer);

  const testAccounts = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // Deployer
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // User 1
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // User 2
  ];

  const mintAmount = ethers.parseUnits("10000", 6); // 10,000 USDC each

  for (const account of testAccounts) {
    console.log(`Minting ${ethers.formatUnits(mintAmount, 6)} USDC to ${account}...`);
    await (await usdc.mint(account, mintAmount)).wait();
  }

  console.log("  Done!");
}

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Loading V3 deployments...\n");

  const hubDeployment = loadDeployment("hub-v3.json");
  const clientDeployment = loadDeployment("client-v3.json");
  const clientBDeployment = loadDeployment("clientB-v3.json");

  if (!hubDeployment) {
    console.error("Hub V3 deployment not found. Run deploy_cctp_v3.ts --network hub first.");
    process.exit(1);
  }

  if (!clientDeployment) {
    console.error("Client V3 deployment not found. Run deploy_cctp_v3.ts --network client first.");
    process.exit(1);
  }

  if (!clientBDeployment) {
    console.error("ClientB V3 deployment not found. Run deploy_cctp_v3.ts --network clientB first.");
    process.exit(1);
  }

  console.log("Deployments loaded:");
  console.log(`  Hub (Domain ${hubDeployment.domain}): Chain ${hubDeployment.chainId}`);
  console.log(`  Client A (Domain ${clientDeployment.domain}): Chain ${clientDeployment.chainId}`);
  console.log(`  Client B (Domain ${clientBDeployment.domain}): Chain ${clientBDeployment.chainId}`);
  console.log("");

  // Link Hub → Clients
  await linkHubToClients(hubDeployment, clientDeployment, clientBDeployment, deployer);

  // Link Client A → Hub
  await linkClientToHub(
    clientDeployment,
    hubDeployment,
    "http://localhost:8546",
    "Client A"
  );

  // Link Client B → Hub
  await linkClientToHub(
    clientBDeployment,
    hubDeployment,
    "http://localhost:8547",
    "Client B"
  );

  // Mint initial USDC on all chains
  await mintInitialUSDC(hubDeployment, "http://localhost:8545", "Hub");
  await mintInitialUSDC(clientDeployment, "http://localhost:8546", "Client A");
  await mintInitialUSDC(clientBDeployment, "http://localhost:8547", "Client B");

  console.log("\n=== All Deployments Linked Successfully ===\n");
  console.log("You can now run the V3 relayer: npm run relayer-v3");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
