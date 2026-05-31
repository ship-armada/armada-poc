// ABOUTME: Deploys GaslessShieldWrapper (hub) or GaslessShieldWrapperClient (client) and
// ABOUTME: appends its address to the matching privacy-pool deployment manifest.

/**
 * Deploy Gasless Shield Wrapper
 *
 * Phase B2 of the relayer-mediation plan: deploys the permit-based gasless wrappers that
 * back `shield` (hub) and `shield-xchain` (client) for users who hold only USDC.
 *
 *   Hub:    GaslessShieldWrapper       → calls PrivacyPool.shield(...)
 *   Client: GaslessShieldWrapperClient → calls PrivacyPoolClient.crossChainShield(...)
 *
 * Owner = deployer; relayer = deployer.address. The relayer EOA matches the deployer in the
 * POC config (`relayer/config.ts::accounts.deployer`) — the same key submits txs from the
 * armada-relayer process. `setRelayer(addr)` exists on both wrappers for key rotation without
 * redeploy when the relayer wallet later splits from the deployer.
 *
 * Prerequisites:
 *   - privacy-pool deployment manifest for the target chain (deploy_privacy_pool.ts ran first)
 *
 * Usage (local):
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network hub
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network client
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network clientB
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network sepoliaHub
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network sepoliaClientA
 *   npx hardhat run scripts/deploy_gasless_wrapper.ts --network sepoliaClientB
 */

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getChainRole,
  getPrivacyPoolDeploymentFile,
  type ChainRole,
} from "../config/networks";
import { createNonceManager, loadDeployment, saveDeployment } from "./deploy-utils";

async function deployForRole(role: ChainRole): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();
  const nm = await createNonceManager(deployer);
  const isHub = role === "hub";

  const ppFilename = getPrivacyPoolDeploymentFile(role);
  const ppDeployment = loadDeployment(ppFilename);
  if (!ppDeployment) {
    throw new Error(
      `Privacy pool deployment not found (${ppFilename}). Run deploy_privacy_pool.ts first.`,
    );
  }

  const usdcAddress = ppDeployment.cctp?.usdc;
  if (!usdcAddress) {
    throw new Error(
      `Privacy pool manifest at ${ppFilename} is missing cctp.usdc — cannot deploy wrapper.`,
    );
  }

  const poolKey = isHub ? "privacyPool" : "privacyPoolClient";
  const poolAddress = ppDeployment.contracts?.[poolKey];
  if (!poolAddress) {
    throw new Error(
      `Privacy pool manifest at ${ppFilename} is missing contracts.${poolKey}.`,
    );
  }

  const contractName = isHub ? "GaslessShieldWrapper" : "GaslessShieldWrapperClient";
  const manifestKey = isHub ? "gaslessShieldWrapper" : "gaslessShieldWrapperClient";

  console.log(`=== Deploying ${contractName} ===`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Environment: ${config.env}`);
  console.log(`USDC:           ${usdcAddress}`);
  console.log(`Pool:           ${poolAddress}`);
  console.log(`Relayer EOA:    ${deployer.address}  (deployer doubles as relayer in POC)`);
  console.log("");

  const existing = ppDeployment.contracts?.[manifestKey];
  if (existing) {
    console.log(
      `Note: ${manifestKey} already present in manifest (${existing}). Re-deploying with a ` +
        `fresh address; the manifest will be overwritten. setRelayer() can rotate the relayer ` +
        `on the existing wrapper without redeploying if rotation is what you need.`,
    );
  }

  const Wrapper = await ethers.getContractFactory(contractName);
  const wrapper = await Wrapper.deploy(
    usdcAddress,
    poolAddress,
    deployer.address,
    nm.override(),
  );
  await wrapper.deploymentTransaction()!.wait();
  const wrapperAddress = await wrapper.getAddress();
  console.log(`${contractName}: ${wrapperAddress}`);

  // Append to the privacy-pool manifest. Wrappers logically belong with the pool they wrap —
  // co-locating means the frontend reads one file per chain to discover all permit-gasless
  // infrastructure for that chain.
  ppDeployment.contracts = {
    ...ppDeployment.contracts,
    [manifestKey]: wrapperAddress,
  };
  // Bump the manifest timestamp so a downstream consumer can tell the file changed.
  ppDeployment.timestamp = new Date().toISOString();
  saveDeployment(ppFilename, ppDeployment);

  console.log(`\n=== ${contractName} Deployment Complete ===`);
  console.log(`Manifest updated: deployments/${ppFilename}`);
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const config = getNetworkConfig();

  const role = getChainRole(chainId);
  if (!role) {
    console.error(`Unknown chain ID: ${chainId}`);
    console.error(
      `Configured chains: hub=${config.hub.chainId}, clientA=${config.clientA.chainId}, ` +
        `clientB=${config.clientB.chainId}`,
    );
    process.exit(1);
  }

  await deployForRole(role);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
