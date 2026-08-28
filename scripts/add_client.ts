// ABOUTME: Adds ONE new client chain to an already-live hub — the incremental counterpart to
// ABOUTME: link_privacy_pool.ts. Runs only that client's per-client wiring; no hub-wide setup.

/**
 * Add a Client to a Live Deployment
 *
 * Wires a single new client chain into an existing hub without redeploying or re-linking the
 * others. On-chain this is just the per-client subset from link-client.ts: the two owner-gated
 * hub setters (setRemotePool + setRemoteHookRouter for the new domain) plus the client-side
 * hook-router pointers (and, in mock mode, the CCTP cross-references).
 *
 * It deliberately does NOT run link_privacy_pool.ts's hub-wide bootstrap (hub hookRouter,
 * finality default, yield-adapter authorizeAdapter, shield-pause). Re-running those on a
 * hardened deployment would fail — the yield authorizeAdapter step needs PROPOSER/EXECUTOR
 * timelock roles the deployer renounces post-harden — and they are already in place from the
 * original deploy anyway.
 *
 * Prerequisites:
 *   - The new chain is configured in config/*.env (CLIENT_COUNT includes it, CLIENT_<n>_* set)
 *   - CCTP + PrivacyPoolClient (+ gasless wrapper) already deployed on the new chain via the
 *     per-chain scripts (deploy_cctp*, deploy_privacy_pool, deploy_gasless_wrapper)
 *   - The hub PrivacyPool owner key (deployer EOA) is available — these setters are owner-gated
 *
 * Usage (run on the HUB chain), selecting the target client by role:
 *   ADD_CLIENT_ROLE=client3 npx hardhat run scripts/add_client.ts --network sepoliaHub
 */

import "dotenv/config";
import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getCCTPDeploymentFile,
  getPrivacyPoolDeploymentFile,
} from "../config/networks";
import { createNonceManager, loadDeployment } from "./deploy-utils";
import { linkClient } from "./link-client";

async function main() {
  const [signer] = await ethers.getSigners();
  const config = getNetworkConfig();

  const targetRole = process.env.ADD_CLIENT_ROLE;
  if (!targetRole) {
    throw new Error(
      "ADD_CLIENT_ROLE is required (e.g. ADD_CLIENT_ROLE=client3). " +
        `Configured clients: ${config.clients.map((c) => c.role).join(", ")}`,
    );
  }

  const client = config.clients.find((c) => c.role === targetRole);
  if (!client) {
    throw new Error(
      `No client configured for role "${targetRole}". ` +
        `Configured clients: ${config.clients.map((c) => c.role).join(", ")}`,
    );
  }

  console.log("=== Adding Client to Live Deployment ===");
  console.log(`Signer: ${signer.address}`);
  console.log(`Environment: ${config.env}`);
  console.log(`CCTP Mode: ${config.cctpMode}`);
  console.log(`Target: ${client.name} (${client.role}, domain ${client.cctpDomain})`);
  console.log("");

  // Load Hub deployment (must already be live)
  const hubFilename = getPrivacyPoolDeploymentFile("hub");
  const hubDeployment = loadDeployment(hubFilename);
  if (!hubDeployment) {
    throw new Error(`Hub deployment not found (${hubFilename}). The hub must be deployed and linked first.`);
  }

  const hubPoolAddress = hubDeployment.contracts.privacyPool;
  const hubHookRouterAddress = hubDeployment.contracts.hookRouter;
  console.log(`Hub PrivacyPool: ${hubPoolAddress}`);

  const hubCctpFilename = getCCTPDeploymentFile("hub");
  const hubCctp = loadDeployment(hubCctpFilename);
  if (!hubCctp) {
    throw new Error(`Hub CCTP deployment not found (${hubCctpFilename}).`);
  }

  // Guard against re-adding an already-wired client (idempotent-friendly): warn if the domain
  // already has a remote pool set, but proceed — setRemotePool is an overwritable mapping write.
  const privacyPool = await ethers.getContractAt("PrivacyPool", hubPoolAddress);
  const existingRemote: string = await privacyPool.remotePools(client.cctpDomain);
  if (existingRemote && existingRemote !== ethers.ZeroHash) {
    console.log(`Note: domain ${client.cctpDomain} already has a remote pool set (${existingRemote}); re-wiring.`);
    console.log("");
  }

  const nm = await createNonceManager(signer);
  await linkClient(privacyPool, hubHookRouterAddress, hubCctp, client, nm);

  // Verify
  const remotePool = await privacyPool.remotePools(client.cctpDomain);
  const remoteHookRouter = await privacyPool.remoteHookRouters(client.cctpDomain);
  console.log("=== Add Client Complete ===");
  console.log(`  ${client.name} (Domain ${client.cctpDomain})`);
  console.log(`  remotePool:       ${remotePool}`);
  console.log(`  remoteHookRouter: ${remoteHookRouter}`);
  console.log("");
  console.log("Next: add the new chain to the relayer config and restart the relayer.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
