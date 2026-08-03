// ABOUTME: Deploys GaslessShieldWrapper (hub) or GaslessShieldWrapperClient (client) and
// ABOUTME: appends its address to the matching privacy-pool deployment manifest.

/**
 * Deploy Gasless Shield Wrapper
 *
 * Phase C of the relayer-mediation plan: deploys the permissionless permit-based gasless wrappers
 * that back `shield` (hub) and `shield-xchain` (client) for users who hold only USDC.
 *
 *   Hub:    GaslessShieldWrapper       → calls PrivacyPool.shield(...)
 *   Client: GaslessShieldWrapperClient → calls PrivacyPoolClient.crossChainShieldWithFee(...)
 *
 * The wrappers are permissionless: submission is open to any relayer and the fee is paid as a
 * shielded note bound in the user's EIP-712 intent, so there is no stored `relayer` address and no
 * `setRelayer` rotation step — the constructor takes only (usdc, pool).
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
 *
 * Idempotency:
 *   By default the script SKIPS deployment when the manifest already records a wrapper address
 *   that is alive on-chain (`getCode != "0x"`). Re-running after a partial multi-chain failure
 *   only touches chains that need it. The skip is silent-success at exit code 0 so
 *   `npm run setup` orchestration doesn't abort.
 *
 *   Pass `FORCE_REDEPLOY=1` (env var) to override and deploy a fresh wrapper unconditionally —
 *   only useful when intentionally rotating the wrapper itself. Note that a forced redeploy
 *   strands USDC permits + intents the user has already signed against the old address.
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
  console.log("");

  // Idempotency: short-circuit when the manifest already records an address whose contract is
  // alive on-chain. Two-step check (manifest THEN bytecode) handles both "manifest stale, chain
  // wiped" (local Anvil restart) and "deploy partway through, address recorded, contract gone"
  // (RPC failure between deploy success and saveDeployment) cases — we redeploy when the chain
  // says the address is dead, regardless of what the manifest claims.
  const forceRedeploy = process.env.FORCE_REDEPLOY === "1";
  const existing = ppDeployment.contracts?.[manifestKey];
  if (existing && !forceRedeploy) {
    const code = await ethers.provider.getCode(existing);
    if (code !== "0x") {
      console.log(`${contractName} already deployed at ${existing} (manifest + on-chain code).`);
      console.log(`Skipping. Set FORCE_REDEPLOY=1 to deploy a fresh wrapper.`);
      return;
    }
    console.log(
      `${manifestKey} is recorded as ${existing} in the manifest but no contract code exists ` +
        `on-chain (chain wiped, or the prior deploy never landed). Redeploying.`,
    );
  } else if (existing && forceRedeploy) {
    console.log(
      `FORCE_REDEPLOY=1 — overwriting existing ${manifestKey} (${existing}) with a fresh ` +
        `deployment. Permits signed against the old address will be stranded.`,
    );
  }

  const Wrapper = await ethers.getContractFactory(contractName);
  const wrapper = await Wrapper.deploy(
    usdcAddress,
    poolAddress,
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
