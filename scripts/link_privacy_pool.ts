/**
 * Link Privacy Pool Deployments
 *
 * Links the Hub PrivacyPool with Client PrivacyPoolClients:
 *   - Sets remote pool + remote hook router addresses on Hub for each client domain
 *   - Wires each client's hook-router pointers back to the Hub
 *   - Configures CCTP TokenMessenger remote addresses (mock mode only)
 *   - Configures ArmadaYieldAdapter if deployed
 *
 * The per-client wiring is factored into linkClient() so it can be reused both by this
 * bulk link (all clients) and by scripts/add_client.ts (a single new client added to an
 * already-live hub). Hub-wide, once-only steps live in main() and must NOT be re-run when
 * adding a client — notably the yield-adapter authorizeAdapter step, which requires timelock
 * roles the deployer renounces after hardening.
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
import {
  getNetworkConfig,
  getCCTPDeploymentFile,
  getGovernanceDeploymentFile,
  getPrivacyPoolDeploymentFile,
  getYieldDeploymentFile,
  isCCTPReal,
} from "../config/networks";
import { createNonceManager, loadDeployment, timelockCall } from "./deploy-utils";
import { linkClient } from "./link-client";

async function main() {
  const [signer] = await ethers.getSigners();
  const config = getNetworkConfig();
  const nm = await createNonceManager(signer);

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

  const hubHookRouterAddress = hubDeployment.contracts.hookRouter;

  console.log("");
  console.log("Linking clients to Hub...");
  console.log("");

  // Per-client wiring (safe to add clients incrementally — see add_client.ts).
  for (const client of config.clients) {
    await linkClient(privacyPool, hubHookRouterAddress, hubCctp, client, nm);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Hub-wide, once-only setup. These configure the Hub pool itself (not any
  // single client) and must NOT be re-run when adding a client later.
  // ══════════════════════════════════════════════════════════════════════════

  // Set hookRouter on Hub PrivacyPool
  if (hubHookRouterAddress) {
    console.log("Setting hookRouter on Hub PrivacyPool...");
    await (await privacyPool.setHookRouter(hubHookRouterAddress, nm.override())).wait();
    console.log(`  hookRouter set to: ${hubHookRouterAddress}`);
    console.log("");
  }

  // In mock mode, set the Hub MessageTransmitter relayer to the hookRouter and give the Hub
  // TokenMessenger a self-reference (for local operations).
  if (!isCCTPReal()) {
    console.log("Configuring Hub mock CCTP...");
    if (hubHookRouterAddress) {
      const hubMessageTransmitter = await ethers.getContractAt(
        "MockMessageTransmitterV2",
        hubCctp.contracts.messageTransmitter,
      );
      await (await hubMessageTransmitter.setRelayer(hubHookRouterAddress, nm.override())).wait();
      console.log(`  Hub MessageTransmitter relayer set to hookRouter`);
    }

    const hubTokenMessengerBytes32 = ethers.zeroPadValue(hubCctp.contracts.tokenMessenger, 32);
    const hubTokenMessenger = await ethers.getContractAt(
      "MockTokenMessengerV2",
      hubCctp.contracts.tokenMessenger,
    );
    await (await hubTokenMessenger.setRemoteTokenMessenger(config.hub.cctpDomain, hubTokenMessengerBytes32, nm.override())).wait();
    console.log(`  Hub TokenMessenger self-reference set`);
    console.log("");
  } else {
    console.log("CCTP Mode: real — skipping TokenMessenger configuration (managed by Circle)");
  }

  // Configure default finality threshold for outbound unshields
  // (Shields use per-transaction user choice; this only affects unshields via TransactModule)
  const useFastFinality = config.cctpFinalityMode === "fast";

  if (useFastFinality) {
    console.log("Configuring CCTP fast finality defaults for outbound unshields...");

    // Set default finality threshold to FAST (1000) on Hub (for outbound unshields)
    await (await privacyPool.setDefaultFinalityThreshold(1000, nm.override())).wait();
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

    // Idempotent: if the adapter is already pointing at this pool, skip the setter — the
    // call would revert under "not owner" after Phase 6 transfers adapter ownership to the
    // timelock, but the desired end-state is already in place so this is a clean no-op.
    const currentPool: string = await adapter.privacyPool();
    if (currentPool.toLowerCase() === hubPoolAddress.toLowerCase()) {
      console.log(`  Adapter privacy pool already set to: ${hubPoolAddress} (skip)`);
    } else {
      await (await adapter.setPrivacyPool(hubPoolAddress, nm.override())).wait();
      console.log(`  Adapter privacy pool set to: ${hubPoolAddress}`);
    }
    // Authorize adapter in governance adapter registry. Both local (Anvil impersonation)
    // and non-local (real timelock schedule + wait + execute) paths are now handled inside
    // timelockCall — see scripts/deploy-utils.ts. Non-local requires the deployer to hold
    // PROPOSER_ROLE + EXECUTOR_ROLE on the timelock (granted in deploy_governance.ts).
    const govFilename = getGovernanceDeploymentFile();
    const govDeployment = loadDeployment(govFilename);
    if (govDeployment?.contracts?.adapterRegistry && govDeployment?.contracts?.timelockController) {
      const timelockAddr = govDeployment.contracts.timelockController;
      const registryAddr = govDeployment.contracts.adapterRegistry;
      const registry = await ethers.getContractAt("AdapterRegistry", registryAddr);
      const calldata = registry.interface.encodeFunctionData("authorizeAdapter", [adapterAddress]);
      await timelockCall(
        timelockAddr,
        registryAddr,
        calldata,
        "AdapterRegistry.authorizeAdapter()",
        nm,
      );

      // Point the pool at the registry so ShieldModule derives fee-exempt shield privilege from it
      // (issue #370). setAdapterRegistry is set-once — idempotent: skip if already pointing at this
      // registry, since a second call would revert on the set-once guard.
      const currentRegistry: string = await privacyPool.adapterRegistry();
      if (currentRegistry.toLowerCase() === registryAddr.toLowerCase()) {
        console.log(`  Pool adapterRegistry already set to: ${registryAddr} (skip)`);
      } else {
        await (await privacyPool.setAdapterRegistry(registryAddr, nm.override())).wait();
        console.log(`  Pool adapterRegistry set to: ${registryAddr} (fee-exempt yield path)`);
      }
    }
  }

  // Wire ShieldPauseController to Hub PrivacyPool (if governance is deployed)
  const govFilenameForPause = getGovernanceDeploymentFile();
  const govDeploymentForPause = loadDeployment(govFilenameForPause);
  if (govDeploymentForPause?.contracts?.shieldPauseController) {
    const shieldPauseAddress = govDeploymentForPause.contracts.shieldPauseController;
    console.log("Setting ShieldPauseController on Hub PrivacyPool...");
    await (await privacyPool.setShieldPauseContract(shieldPauseAddress, nm.override())).wait();
    console.log(`  shieldPauseContract set to: ${shieldPauseAddress}`);
    console.log("");
  } else {
    console.log("ShieldPauseController: governance not deployed, skipping");
    console.log("");
  }

  console.log("");
  console.log("=== Linking Complete ===");
  console.log("");
  console.log("Summary:");
  console.log(`  Hub PrivacyPool: ${hubPoolAddress}`);

  // Verify remote pools
  for (const client of config.clients) {
    const remotePool = await privacyPool.remotePools(client.cctpDomain);
    console.log(`  ${client.name} (Domain ${client.cctpDomain}): ${remotePool}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
