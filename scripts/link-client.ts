// ABOUTME: Per-client Hub<->Client wiring, shared by link_privacy_pool.ts (bulk link of all
// ABOUTME: clients) and add_client.ts (adding one new client to an already-live hub).

import { ethers } from "hardhat";
import {
  getNetworkConfig,
  getCCTPDeploymentFile,
  getPrivacyPoolDeploymentFile,
  isCCTPReal,
  type ChainConfig,
} from "../config/networks";
import { createNonceManager, loadDeployment } from "./deploy-utils";

type NonceManager = Awaited<ReturnType<typeof createNonceManager>>;

/**
 * Wire a single client chain into the Hub. This is the per-client subset of linking:
 *   - Hub (owner-gated): setRemotePool + setRemoteHookRouter for the client's domain
 *   - Client: setHookRouter + setHubHookRouter
 *   - Mock CCTP only: TokenMessenger/MessageTransmitter cross-references both ways
 *
 * It only writes the given client's domain entries and touches that client's own contracts,
 * so it is safe to call against a live hub to add a brand-new client (see add_client.ts).
 * Hub-wide, once-only setup (hub hookRouter, finality default, yield adapter, shield-pause)
 * is intentionally NOT done here — that lives in link_privacy_pool.ts's main().
 *
 * @param privacyPool          Hub PrivacyPool contract (connected to the hub network signer)
 * @param hubHookRouterAddress Hub's CCTPHookRouter address (pinned as the client's destinationCaller)
 * @param hubCctp              Hub CCTP deployment manifest (for mock cross-references)
 * @param client               Client chain config (from config.clients)
 * @param nm                   Nonce manager for the hub network signer
 */
export async function linkClient(
  privacyPool: any,
  hubHookRouterAddress: string | undefined,
  hubCctp: any,
  client: ChainConfig,
  nm: NonceManager,
): Promise<void> {
  const config = getNetworkConfig();
  const domain = client.cctpDomain;
  console.log(`--- ${client.name} (Domain ${domain}) ---`);

  const clientFilename = getPrivacyPoolDeploymentFile(client.role);
  const clientDeployment = loadDeployment(clientFilename);
  if (!clientDeployment) {
    console.log(`  Warning: ${client.name} deployment not found (${clientFilename}), skipping`);
    return;
  }

  const clientAddress = clientDeployment.contracts.privacyPoolClient;
  const clientBytes32 = ethers.zeroPadValue(clientAddress, 32);
  console.log(`  PrivacyPoolClient: ${clientAddress}`);

  // Set remote pool on Hub
  console.log(`  Setting remote pool on Hub...`);
  await (await privacyPool.setRemotePool(domain, clientBytes32, nm.override())).wait();
  console.log(`  Remote pool set for domain ${domain}`);

  // Set the client's hook router on Hub — pinned as the CCTP destinationCaller for Hub->client
  // unshield burns, so a burn to this domain can only be delivered via the client's CCTPHookRouter.
  if (clientDeployment.contracts.hookRouter) {
    const clientHookRouterBytes32 = ethers.zeroPadValue(clientDeployment.contracts.hookRouter, 32);
    console.log(`  Setting remote hook router on Hub...`);
    await (await privacyPool.setRemoteHookRouter(domain, clientHookRouterBytes32, nm.override())).wait();
    console.log(`  Remote hook router set for domain ${domain}`);
  } else {
    console.log(`  Warning: ${client.name} has no hookRouter — remoteHookRouter NOT set (unshields to this domain will revert)`);
  }

  // In mock mode, configure the Hub's TokenMessenger to know this client's TokenMessenger.
  // In real CCTP mode, Circle manages this — skip.
  if (!isCCTPReal()) {
    const clientCctp = loadDeployment(getCCTPDeploymentFile(client.role));
    if (clientCctp) {
      const hubTokenMessenger = await ethers.getContractAt(
        "MockTokenMessengerV2",
        hubCctp.contracts.tokenMessenger,
      );
      const clientTokenMessengerBytes32 = ethers.zeroPadValue(clientCctp.contracts.tokenMessenger, 32);
      console.log(`  Setting remote TokenMessenger on Hub...`);
      await (await hubTokenMessenger.setRemoteTokenMessenger(
        domain,
        clientTokenMessengerBytes32,
        nm.override(),
      )).wait();
      console.log(`  Remote TokenMessenger set for domain ${domain}`);
    }
  }

  // Client-side wiring runs on the client chain, so it needs a signer there (a fresh provider
  // + the deployer wallet), independent of the hub network's nonce manager.
  if (clientDeployment.contracts.hookRouter) {
    const clientProvider = new ethers.JsonRpcProvider(client.rpc);
    const clientSigner = new ethers.Wallet(config.deployerPrivateKey, clientProvider);

    const clientPoolContract = new ethers.Contract(
      clientDeployment.contracts.privacyPoolClient,
      [
        "function setHookRouter(address _hookRouter) external",
        "function setHubHookRouter(bytes32 _hubHookRouter) external",
      ],
      clientSigner,
    );

    console.log(`  Setting hookRouter on ${client.name} PrivacyPoolClient...`);
    await (await clientPoolContract.setHookRouter(clientDeployment.contracts.hookRouter)).wait();
    console.log(`  hookRouter set to: ${clientDeployment.contracts.hookRouter}`);

    // Pin the Hub's hook router as the CCTP destinationCaller for client->Hub shield burns, so a
    // shield can only be delivered via the Hub's CCTPHookRouter.
    if (hubHookRouterAddress) {
      const hubHookRouterBytes32 = ethers.zeroPadValue(hubHookRouterAddress, 32);
      console.log(`  Setting hubHookRouter on ${client.name} PrivacyPoolClient...`);
      await (await clientPoolContract.setHubHookRouter(hubHookRouterBytes32)).wait();
      console.log(`  hubHookRouter set to: ${hubHookRouterAddress}`);
    } else {
      console.log(`  Warning: Hub has no hookRouter — hubHookRouter NOT set (shields from ${client.name} will revert)`);
    }

    // In mock mode, the client's MessageTransmitter must let the hookRouter call receiveMessage,
    // and the client's TokenMessenger must know the Hub's TokenMessenger address.
    if (!isCCTPReal()) {
      const clientCctp = loadDeployment(getCCTPDeploymentFile(client.role));
      if (clientCctp) {
        const clientMessageTransmitter = new ethers.Contract(
          clientCctp.contracts.messageTransmitter,
          ["function setRelayer(address _relayer) external"],
          clientSigner,
        );
        await (await clientMessageTransmitter.setRelayer(clientDeployment.contracts.hookRouter)).wait();
        console.log(`  ${client.name} MessageTransmitter relayer set to hookRouter`);

        const hubTokenMessengerBytes32 = ethers.zeroPadValue(hubCctp.contracts.tokenMessenger, 32);
        const clientTokenMessenger = new ethers.Contract(
          clientCctp.contracts.tokenMessenger,
          ["function setRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external"],
          clientSigner,
        );
        await (await clientTokenMessenger.setRemoteTokenMessenger(
          config.hub.cctpDomain,
          hubTokenMessengerBytes32,
        )).wait();
        console.log(`  Hub TokenMessenger set on ${client.name}`);
      }
    }
  }

  console.log("");
}
