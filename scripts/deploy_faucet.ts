/**
 * Deploy Faucet contracts to all chains
 *
 * Usage:
 *   npx hardhat run scripts/deploy_faucet.ts
 */

import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments");

// Anvil default account 0 — publicly known, acceptable for local dev only
const ANVIL_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// ABI for adding faucet as minter on MockUSDCV2
const USDC_V3_ABI = ['function addMinter(address minter) external'];

interface Deployment {
  chainId: number;
  deployer: string;
  contracts: Record<string, string>;
  timestamp: string;
}

function loadDeployment(name: string): Deployment | null {
  const filePath = path.join(DEPLOYMENTS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveDeployment(name: string, deployment: Deployment): void {
  const filePath = path.join(DEPLOYMENTS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(deployment, null, 2));
}

async function deployFaucet(
  chainName: string,
  rpcUrl: string,
  v2DeploymentName: string,
  v3DeploymentName: string
) {
  console.log(`\nDeploying Faucet to ${chainName}...`);

  // Connect to the chain. Use DEPLOYER_PRIVATE_KEY if set, otherwise fall back
  // to the Anvil default key (local dev only — same pattern as hardhat.config.ts).
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || ANVIL_DEFAULT_KEY;
  const deployer = new ethers.Wallet(privateKey, provider);

  console.log(`Deployer: ${deployer.address}`);

  // Try V3 deployment first, fall back to V2
  const v3Deployment = loadDeployment(v3DeploymentName);
  const v2Deployment = loadDeployment(v2DeploymentName);

  // V3 uses 'usdc', V2 uses 'mockUSDC'
  const usdcAddress = v3Deployment?.contracts.usdc || v2Deployment?.contracts.mockUSDC;

  if (!usdcAddress) {
    throw new Error(`USDC not found in ${v3DeploymentName} or ${v2DeploymentName} deployment`);
  }

  const isV3 = !!v3Deployment?.contracts.usdc;
  console.log(`Using ${isV3 ? 'V3' : 'V2'} deployment`);
  console.log(`USDC address: ${usdcAddress}`);

  // Deploy Faucet with 100 ETH
  const Faucet = await ethers.getContractFactory("Faucet", deployer);
  const faucet = await Faucet.deploy(usdcAddress, {
    value: ethers.parseEther("100"),
  });
  await faucet.waitForDeployment();

  const faucetAddress = await faucet.getAddress();
  console.log(`Faucet deployed to: ${faucetAddress}`);

  // For V3 (MockUSDCV2), add Faucet as a minter
  if (isV3) {
    console.log(`Adding Faucet as minter on MockUSDCV2...`);
    const usdc = new ethers.Contract(usdcAddress, USDC_V3_ABI, deployer);
    await (await usdc.addMinter(faucetAddress)).wait();
    console.log(`  Faucet added as minter`);
  }

  // Update both deployment files if they exist
  if (v3Deployment) {
    v3Deployment.contracts.faucet = faucetAddress;
    v3Deployment.timestamp = new Date().toISOString();
    saveDeployment(v3DeploymentName, v3Deployment);
    console.log(`Updated ${v3DeploymentName}.json with faucet address`);
  }

  if (v2Deployment) {
    v2Deployment.contracts.faucet = faucetAddress;
    v2Deployment.timestamp = new Date().toISOString();
    saveDeployment(v2DeploymentName, v2Deployment);
    console.log(`Updated ${v2DeploymentName}.json with faucet address`);
  }

  return faucetAddress;
}

async function main() {
  // Faucets are local-only — hardcoded localhost URLs and Anvil private key
  if (process.env.DEPLOY_ENV && process.env.DEPLOY_ENV !== "local") {
    throw new Error("deploy_faucet.ts is local-only. Do not run on testnet/mainnet.");
  }

  console.log("=".repeat(60));
  console.log("Deploying Faucet contracts to all chains (local only)");
  console.log("=".repeat(60));

  // Deploy to Hub (port 8545, chain ID 31337)
  await deployFaucet("Hub", "http://localhost:8545", "hub", "hub-v3");

  // Deploy to Client A (port 8546, chain ID 31338)
  await deployFaucet("Client A", "http://localhost:8546", "client", "client-v3");

  // Deploy to Client B (port 8547, chain ID 31339)
  await deployFaucet("Client B", "http://localhost:8547", "clientB", "clientB-v3");

  console.log("\n" + "=".repeat(60));
  console.log("All Faucet contracts deployed!");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
