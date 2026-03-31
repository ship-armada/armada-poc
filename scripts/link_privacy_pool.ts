/**
 * Link Privacy Pool Deployments
 *
 * Links the Hub PrivacyPool with Client PrivacyPoolClients:
 *   - Sets remote pool addresses on Hub for each client domain
 *   - Configures CCTP TokenMessenger remote addresses (mock mode only)
 *   - Configures ArmadaYieldAdapter if deployed
 *
 * Prerequisites:
 *   - CCTP V2 contracts deployed/configured on all chains
 *   - Privacy Pool contracts deployed on all chains
 *
 * Usage (local):
 *   npx hardhat run scripts/link_privacy_pool.ts --network hub
 *
 * Usage (sepolia):
 *   npx hardhat run scripts/link_privacy_pool.ts --network sepoliaHub
 *
 * Note: Run this on the Hub chain after all deployments are complete.
 */

import "dotenv/config";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  getNetworkConfig,
  getCCTPDeploymentFile,
  getGovernanceDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  isCCTPReal,
  type ChainRole,
} from "../config/networks";

interface LinkConfig {
  role: ChainRole;
  domain: number;
  name: string;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const config = getNetworkConfig();

  const clientConfigs: LinkConfig[] = [
    {
      role: "clientA",
      domain: config.clientA.cctpDomain,
      name: config.clientA.name,
    },
    {
      role: "clientB",
      domain: config.clientB.cctpDomain,
      name: config.clientB.name,
    },
  ];

  console.log("=== Linking Privacy Pool Deployments ===");
  console.log(`Signer: ${signer.address}`);
  console.log(`Environment: ${config.env}`);
  console.log(`CCTP Mode: ${config.cctpMode}`);
  console.log("");

  // Load Hub deployment
  const hubFilename = getPrivacyPoolDeploymentFile("hub");
  const hubDeployment = loadDeployment(hubFilename);
  if (!hubDeployment) {
    throw new Error(`Hub deployment not found (${hubFilename}). Run deploy_privacy_pool.ts on hub first.`);
  }

  const hubPoolAddress = hubDeployment.contracts.privacyPool;
  console.log(`Hub PrivacyPool: ${hubPoolAddress}`);

  // Get PrivacyPool contract instance
  const privacyPool = await ethers.getContractAt("PrivacyPool", hubPoolAddress);

  // Load Hub CCTP deployment
  const hubCctpFilename = getCCTPDeploymentFile("hub");
  const hubCctp = loadDeployment(hubCctpFilename);
  if (!hubCctp) {
    throw new Error(`Hub CCTP deployment not found (${hubCctpFilename}).`);
  }

  console.log("");
  console.log("Linking clients to Hub...");
  console.log("");

  // Process each client
  for (const clientConfig of clientConfigs) {
    console.log(`--- ${clientConfig.name} (Domain ${clientConfig.domain}) ---`);

    // Load client privacy pool deployment
    const clientFilename = getPrivacyPoolDeploymentFile(clientConfig.role);
    const clientDeployment = loadDeployment(clientFilename);
    if (!clientDeployment) {
      console.log(`  Warning: ${clientConfig.name} deployment not found (${clientFilename}), skipping`);
      continue;
    }

    const clientAddress = clientDeployment.contracts.privacyPoolClient;
    const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);
    console.log(`  PrivacyPoolClient: ${clientAddress}`);

    // Set remote pool on Hub
    console.log(`  Setting remote pool on Hub...`);
    const setRemoteTx = await privacyPool.setRemotePool(clientConfig.domain, clientBytes32);
    await setRemoteTx.wait();
    console.log(`  Remote pool set for domain ${clientConfig.domain}`);

    // In mock mode, we need to configure TokenMessenger cross-references
    // In real CCTP mode, Circle manages this - skip
    if (!isCCTPReal()) {
      const clientCctpFilename = getCCTPDeploymentFile(clientConfig.role);
      const clientCctp = loadDeployment(clientCctpFilename);
      if (clientCctp) {
        // Set remote TokenMessenger on Hub (Hub -> Client)
        const hubTokenMessenger = await ethers.getContractAt(
          "MockTokenMessengerV2",
          hubCctp.contracts.tokenMessenger
        );
        const clientTokenMessengerBytes32 = ethers.zeroPadValue(
          clientCctp.contracts.tokenMessenger,
          32
        );
        console.log(`  Setting remote TokenMessenger on Hub...`);
        await (await hubTokenMessenger.setRemoteTokenMessenger(
          clientConfig.domain,
          clientTokenMessengerBytes32
        )).wait();
        console.log(`  Remote TokenMessenger set for domain ${clientConfig.domain}`);
      }
    }

    console.log("");
  }

  // Set hookRouter on Hub PrivacyPool
  const hubHookRouterAddress = hubDeployment.contracts.hookRouter;
  if (hubHookRouterAddress) {
    console.log("Setting hookRouter on Hub PrivacyPool...");
    await (await privacyPool.setHookRouter(hubHookRouterAddress)).wait();
    console.log(`  hookRouter set to: ${hubHookRouterAddress}`);
    console.log("");
  }

  // Set hookRouter on each Client PrivacyPoolClient
  for (const clientConfig of clientConfigs) {
    const clientFilename = getPrivacyPoolDeploymentFile(clientConfig.role);
    const clientDeployment = loadDeployment(clientFilename);
    if (!clientDeployment?.contracts?.hookRouter) continue;

    const chain = clientConfig.role === "clientA" ? config.clientA : config.clientB;
    const clientProvider = new ethers.JsonRpcProvider(chain.rpc);
    const clientSigner = new ethers.Wallet(config.deployerPrivateKey, clientProvider);

    const clientPoolContract = new ethers.Contract(
      clientDeployment.contracts.privacyPoolClient,
      ["function setHookRouter(address _hookRouter) external"],
      clientSigner
    );

    console.log(`Setting hookRouter on ${clientConfig.name} PrivacyPoolClient...`);
    await (await clientPoolContract.setHookRouter(clientDeployment.contracts.hookRouter)).wait();
    console.log(`  hookRouter set to: ${clientDeployment.contracts.hookRouter}`);
    console.log("");
  }

  // In mock mode, set MessageTransmitter relayer to hookRouter
  // so hookRouter can call receiveMessage on mock
  if (!isCCTPReal()) {
    console.log("Setting mock MessageTransmitter relayers to hookRouter...");

    // Hub MessageTransmitter
    if (hubHookRouterAddress) {
      const hubMessageTransmitter = await ethers.getContractAt(
        "MockMessageTransmitterV2",
        hubCctp.contracts.messageTransmitter
      );
      await (await hubMessageTransmitter.setRelayer(hubHookRouterAddress)).wait();
      console.log(`  Hub MessageTransmitter relayer set to hookRouter`);
    }

    // Client MessageTransmitters
    for (const clientConfig of clientConfigs) {
      const clientFilename = getPrivacyPoolDeploymentFile(clientConfig.role);
      const clientDeployment = loadDeployment(clientFilename);
      if (!clientDeployment?.contracts?.hookRouter) continue;

      const clientCctpFilename = getCCTPDeploymentFile(clientConfig.role);
      const clientCctp = loadDeployment(clientCctpFilename);
      if (!clientCctp) continue;

      const chain = clientConfig.role === "clientA" ? config.clientA : config.clientB;
      const clientProvider = new ethers.JsonRpcProvider(chain.rpc);
      const clientSigner = new ethers.Wallet(config.deployerPrivateKey, clientProvider);

      const clientMessageTransmitter = new ethers.Contract(
        clientCctp.contracts.messageTransmitter,
        ["function setRelayer(address _relayer) external"],
        clientSigner
      );

      await (await clientMessageTransmitter.setRelayer(clientDeployment.contracts.hookRouter)).wait();
      console.log(`  ${clientConfig.name} MessageTransmitter relayer set to hookRouter`);
    }

    console.log("");
  }

  // In mock mode, configure Client TokenMessengers to know about Hub
  if (!isCCTPReal()) {
    const hubTokenMessengerBytes32 = ethers.zeroPadValue(
      hubCctp.contracts.tokenMessenger,
      32
    );

    console.log("Configuring Client TokenMessengers with Hub address...");
    console.log("");

    for (const clientConfig of clientConfigs) {
      const clientCctpFilename = getCCTPDeploymentFile(clientConfig.role);
      const clientCctp = loadDeployment(clientCctpFilename);
      if (!clientCctp) continue;

      // Connect to client chain
      const chain = clientConfig.role === "clientA" ? config.clientA : config.clientB;
      const clientProvider = new ethers.JsonRpcProvider(chain.rpc);
      const clientSigner = new ethers.Wallet(
        config.deployerPrivateKey,
        clientProvider
      );

      const clientTokenMessenger = new ethers.Contract(
        clientCctp.contracts.tokenMessenger,
        ["function setRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external"],
        clientSigner
      );

      console.log(`  Setting Hub TokenMessenger on ${clientConfig.name}...`);
      const tx = await clientTokenMessenger.setRemoteTokenMessenger(
        config.hub.cctpDomain,
        hubTokenMessengerBytes32
      );
      await tx.wait();
      console.log(`  Hub TokenMessenger set on ${clientConfig.name}`);
    }

    console.log("");

    // Set Hub TokenMessenger self-reference (for local operations)
    const hubTokenMessenger = await ethers.getContractAt(
      "MockTokenMessengerV2",
      hubCctp.contracts.tokenMessenger
    );
    await (await hubTokenMessenger.setRemoteTokenMessenger(config.hub.cctpDomain, hubTokenMessengerBytes32)).wait();
    console.log(`Hub TokenMessenger self-reference set`);
  } else {
    console.log("CCTP Mode: real — skipping TokenMessenger configuration (managed by Circle)");
  }

  // Configure default finality threshold for outbound unshields
  // (Shields use per-transaction user choice; this only affects unshields via TransactModule)
  const useFastFinality = config.cctpFinalityMode === "fast";

  if (useFastFinality) {
    console.log("Configuring CCTP fast finality defaults for outbound unshields...");

    // Set default finality threshold to FAST (1000) on Hub (for outbound unshields)
    await (await privacyPool.setDefaultFinalityThreshold(1000)).wait();
    console.log("  Hub PrivacyPool: defaultFinalityThreshold = FAST (1000)");

    console.log("");
  } else {
    console.log("CCTP Finality Mode: standard (unshields use finalized finality)");
    console.log("");
  }

  // Configure ArmadaYieldAdapter if yield is deployed
  const yieldFilename = getYieldDeploymentFile();
  const yieldDeployment = loadDeployment(yieldFilename);
  if (yieldDeployment?.contracts?.armadaYieldAdapter) {
    const adapterAddress = yieldDeployment.contracts.armadaYieldAdapter;
    console.log("");
    console.log("Configuring ArmadaYieldAdapter...");
    const adapter = await ethers.getContractAt("ArmadaYieldAdapter", adapterAddress);
    await (await adapter.setPrivacyPool(hubPoolAddress)).wait();
    console.log(`  Adapter privacy pool set to: ${hubPoolAddress}`);
    await (await privacyPool.setPrivilegedShieldCaller(adapterAddress, true)).wait();
    console.log(`  Adapter set as privileged shield caller (fee exemption)`);

    // Authorize adapter in governance adapter registry (via timelock impersonation on local)
    const govFilename = getGovernanceDeploymentFile();
    const govDeployment = loadDeployment(govFilename);
    if (govDeployment?.contracts?.adapterRegistry && govDeployment?.contracts?.timelockController) {
      const timelockAddr = govDeployment.contracts.timelockController;
      const registryAddr = govDeployment.contracts.adapterRegistry;

      // Impersonate timelock to call authorizeAdapter directly (local/Anvil only)
      const [deployer] = await ethers.getSigners();
      await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
      const timelockSigner = await ethers.getImpersonatedSigner(timelockAddr);
      const registry = await ethers.getContractAt("AdapterRegistry", registryAddr);
      await (await registry.connect(timelockSigner).authorizeAdapter(adapterAddress)).wait();
      console.log(`  Adapter authorized in adapter registry`);
    }
  }

  console.log("");
  console.log("=== Linking Complete ===");
  console.log("");
  console.log("Summary:");
  console.log(`  Hub PrivacyPool: ${hubPoolAddress}`);

  // Verify remote pools
  for (const clientConfig of clientConfigs) {
    const remotePool = await privacyPool.remotePools(clientConfig.domain);
    console.log(`  ${clientConfig.name} (Domain ${clientConfig.domain}): ${remotePool}`);
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
