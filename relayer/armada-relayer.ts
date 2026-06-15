/**
 * Armada Relayer — Entry Point
 *
 * Unified relayer service that handles:
 * 1. Privacy Relay: Submit shielded transactions on behalf of users
 *    (multi-chain — hub + every configured client. Phase A selectors run on hub; Phase B2
 *    gasless-shield wrapper selectors run on whichever chain the user signed the permit for.)
 * 2. CCTP Relay: Forward cross-chain CCTP messages between all chains
 *
 * Environment-aware:
 *   - Local (CCTP_MODE=mock): Uses mock message relay with no attestation
 *   - Testnet (CCTP_MODE=real): Uses Circle's Iris attestation service
 *
 * Loads contract addresses from per-chain deployment JSONs and starts all modules.
 */

import * as fs from "fs";
import * as path from "path";
import { armadaRelayerSettings, allChains, hubChain, clientChains } from "./config";
import { WalletManager } from "./modules/wallet-manager";
import { FeeCalculator } from "./modules/fee-calculator";
import { PrivacyRelay } from "./modules/privacy-relay";
import { RelayerRailgunWallet } from "./modules/railgun-wallet";
import { HttpApi } from "./modules/http-api";
import { Counters } from "./modules/counters";
import { CCTPRelayModule } from "./modules/cctp-relay";
import { IrisRelayModule } from "./modules/iris-relay";
import type { PrivacyPoolDeployment, CCTPDeployment, RelayerHealth } from "./types";
import { getNetworkConfig } from "../config/networks";
import { installBisectingGetLogs } from "./lib/rpc-bisecting";
import { NonceCoordinator } from "./lib/nonce-coordinator";

// Install the eth_getLogs bisecting patch at module load — before ANY JsonRpcProvider is
// constructed (the patch is at the prototype level so this is technically order-independent,
// but placing it here makes the intent obvious to anyone reading top-to-bottom). Adapts to
// whatever per-call cap the configured RPC enforces (Alchemy free = 10 blocks, Infura = 10k,
// etc.) without per-provider configuration.
installBisectingGetLogs();

// ============ Deployment Loading ============

function loadJson<T>(filename: string): T | null {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

interface YieldDeployment {
  chainId: number;
  contracts: { armadaYieldAdapter: string };
}

interface HubContractAddresses {
  privacyPool: string;
  armadaYieldAdapter: string;
  usdc: string;
  messageTransmitter: string;
  tokenMessenger: string;
  /** Phase B2 wrapper. Optional — relayer logs a warning when absent. */
  gaslessShieldWrapper?: string;
}

interface ClientContractAddresses {
  chainId: number;
  privacyPoolClient: string;
  /** Phase B2 wrapper. Optional — relayer logs a warning when absent. */
  gaslessShieldWrapperClient?: string;
}

function loadHubAddresses(): HubContractAddresses {
  const netConfig = getNetworkConfig();
  const suffix = netConfig.env === "local" ? "" : `-${netConfig.env}`;

  const ppFile = `privacy-pool-hub${suffix}.json`;
  const ppDeployment = loadJson<PrivacyPoolDeployment>(ppFile);
  if (!ppDeployment) {
    throw new Error(`${ppFile} not found. Run deployment scripts first.`);
  }
  if (!ppDeployment.contracts.privacyPool) {
    throw new Error(`${ppFile} is missing contracts.privacyPool.`);
  }

  const yieldFile = `yield-hub${suffix}.json`;
  const yieldDeployment = loadJson<YieldDeployment>(yieldFile);
  if (!yieldDeployment?.contracts?.armadaYieldAdapter) {
    throw new Error(
      `${yieldFile} with armadaYieldAdapter not found. Run deploy_yield.ts first.`,
    );
  }

  const cctpFile = `hub${suffix}-v3.json`;
  const cctpDeployment = loadJson<CCTPDeployment>(cctpFile);
  if (!cctpDeployment) {
    throw new Error(`${cctpFile} not found. Run deployment scripts first.`);
  }

  return {
    privacyPool: ppDeployment.contracts.privacyPool,
    armadaYieldAdapter: yieldDeployment.contracts.armadaYieldAdapter,
    usdc: cctpDeployment.contracts.usdc,
    messageTransmitter: cctpDeployment.contracts.messageTransmitter,
    tokenMessenger: cctpDeployment.contracts.tokenMessenger,
    gaslessShieldWrapper: ppDeployment.contracts.gaslessShieldWrapper,
  };
}

function loadClientAddresses(): ClientContractAddresses[] {
  const netConfig = getNetworkConfig();
  const suffix = netConfig.env === "local" ? "" : `-${netConfig.env}`;
  const out: ClientContractAddresses[] = [];

  // Map each configured client chain to its privacy-pool manifest. The filenames mirror the
  // deployment-script convention: `privacy-pool-{prefix}{-env}.json`.
  for (const chain of clientChains) {
    // chain.privacyPoolDeploymentFile already encodes the per-env suffix.
    const ppDeployment = loadJson<PrivacyPoolDeployment>(chain.privacyPoolDeploymentFile);
    if (!ppDeployment) {
      console.warn(
        `[armada] ${chain.privacyPoolDeploymentFile} not found — client chain ${chain.chainId} (${chain.name}) will have no allowed targets. Phase B2 gasless-shield on this chain will reject as INVALID_TARGET.`,
      );
      continue;
    }
    if (!ppDeployment.contracts.privacyPoolClient) {
      console.warn(
        `[armada] ${chain.privacyPoolDeploymentFile} is missing contracts.privacyPoolClient — client chain ${chain.chainId} will have no allowed targets.`,
      );
      continue;
    }
    out.push({
      chainId: chain.chainId,
      privacyPoolClient: ppDeployment.contracts.privacyPoolClient,
      gaslessShieldWrapperClient: ppDeployment.contracts.gaslessShieldWrapperClient,
    });
    // Tell the operator unambiguously whether B2 wrappers are wired up.
    const wrapperStatus = ppDeployment.contracts.gaslessShieldWrapperClient
      ? ppDeployment.contracts.gaslessShieldWrapperClient
      : "(not deployed — gaslessCrossChainShield will reject as INVALID_TARGET)";
    console.log(`  chain=${chain.chainId} (${chain.name}) wrapper=${wrapperStatus}`);
  }

  return out;
}

// ============ Main ============

async function main() {
  const netConfig = getNetworkConfig();

  console.log("=".repeat(60));
  console.log("  ARMADA RELAYER");
  console.log(`  Environment: ${netConfig.env}`);
  console.log(`  CCTP Mode: ${netConfig.cctpMode}`);
  console.log("=".repeat(60));
  console.log();

  // Load contract addresses (hub + each client)
  console.log("[armada] Loading deployment configuration...");
  let hubAddresses: HubContractAddresses;
  let clientAddresses: ClientContractAddresses[];
  try {
    hubAddresses = loadHubAddresses();
    clientAddresses = loadClientAddresses();
  } catch (e: any) {
    console.error(`[armada] ${e.message}`);
    process.exit(1);
  }

  console.log("[armada] Hub contract addresses:");
  console.log(`  PrivacyPool:           ${hubAddresses.privacyPool}`);
  console.log(`  ArmadaYieldAdapter:    ${hubAddresses.armadaYieldAdapter}`);
  console.log(`  USDC:                  ${hubAddresses.usdc}`);
  console.log(`  MessageTransmitter:    ${hubAddresses.messageTransmitter}`);
  console.log(`  TokenMessenger:        ${hubAddresses.tokenMessenger}`);
  console.log(
    `  GaslessShieldWrapper:  ${hubAddresses.gaslessShieldWrapper ?? "(not deployed — gaslessShield will reject as INVALID_TARGET)"}`,
  );
  console.log();

  // One nonce authority for the whole process. The privacy relay (WalletManager) and the CCTP
  // relay (iris/cctp module) both submit from the SAME EOA on the SAME chains; sharing this
  // coordinator is what stops their nonce streams from colliding and silently replacing each
  // other's transactions in the mempool. Keyed by chainId — assumes one EOA per chain, which
  // holds today (all paths use the deployer/relayer key) and after the optional RELAYER_PRIVATE_KEY
  // split (still one key for every path).
  const nonceCoordinator = new NonceCoordinator();

  // In-process counters surfaced on /health. Created here (ahead of WalletManager) because the
  // wallet manager records stuck-broadcast events into it.
  const counters = new Counters();

  // Initialize wallet manager — multi-chain (one provider + same EOA across all chains)
  console.log("[armada] Initializing wallet manager...");
  const walletManager = new WalletManager(nonceCoordinator, counters);
  await walletManager.initialize();
  console.log();

  // Initialize the relayer's Railgun (0zk) wallet — engine boot + mnemonic-derived wallet.
  // MUST precede FeeCalculator so the derived address is published on `/fees` from the first
  // request, and MUST precede PrivacyRelay so broadcaster-fee verification has a viewing key.
  console.log("[armada] Initializing relayer Railgun wallet...");
  const railgunWallet = new RelayerRailgunWallet();
  const { walletId: railgunWalletId, railgunAddress } = await railgunWallet.initialize();
  console.log(`  Wallet ID: ${railgunWalletId.slice(0, 16)}...`);
  console.log(`  Broadcaster address: ${railgunAddress}`);
  console.log();

  // Per-chain fee calculators. Each holds its own provider so the quoted gas price reflects
  // the actual cost on that chain (Base Sepolia ~10x cheaper than Ethereum Sepolia today).
  console.log("[armada] Initializing per-chain fee calculators...");
  const feeCalculators = new Map<number, FeeCalculator>();
  for (const chain of allChains) {
    const provider = walletManager.getProvider(chain.chainId);
    const calc = new FeeCalculator(provider, chain.chainId, railgunAddress);
    feeCalculators.set(chain.chainId, calc);
    const initial = await calc.generateFeeSchedule();
    console.log(`  chain=${chain.chainId} (${chain.name})`);
    console.log(`    shield:            ${FeeCalculator.formatUsdcFee(initial.fees.shield)}`);
    console.log(`    shieldXchain:      ${FeeCalculator.formatUsdcFee(initial.fees.shieldXchain)}`);
    console.log(`    transfer/unshield: ${FeeCalculator.formatUsdcFee(initial.fees.transfer)} / ${FeeCalculator.formatUsdcFee(initial.fees.unshield)}`);
    console.log(`    crossContract:     ${FeeCalculator.formatUsdcFee(initial.fees.crossContract)}`);
    console.log(`    crossChainUnshield:${FeeCalculator.formatUsdcFee(initial.fees.crossChainUnshield)}`);
    console.log(`    cacheId:           ${initial.cacheId}`);
  }
  console.log();

  // Build the per-chain allowed-targets map.
  //   hub:    PrivacyPool + ArmadaYieldAdapter + (optional) GaslessShieldWrapper
  //   client: GaslessShieldWrapperClient (when deployed)
  // Phase A selectors are hub-only today, so clients only need the wrapper allow-listed.
  const allowedTargetsByChain = new Map<number, string[]>();
  const hubTargets: string[] = [hubAddresses.privacyPool, hubAddresses.armadaYieldAdapter];
  if (hubAddresses.gaslessShieldWrapper) {
    hubTargets.push(hubAddresses.gaslessShieldWrapper);
  }
  allowedTargetsByChain.set(hubChain.chainId, hubTargets);
  for (const cli of clientAddresses) {
    const targets: string[] = [cli.privacyPoolClient];
    if (cli.gaslessShieldWrapperClient) {
      targets.push(cli.gaslessShieldWrapperClient);
    }
    allowedTargetsByChain.set(cli.chainId, targets);
  }

  // Build the per-chain wrapper map for gasless-fee-verifier (lookup hot-path).
  const wrappersByChain = new Map<number, string>();
  if (hubAddresses.gaslessShieldWrapper) {
    wrappersByChain.set(hubChain.chainId, hubAddresses.gaslessShieldWrapper);
  }
  for (const cli of clientAddresses) {
    if (cli.gaslessShieldWrapperClient) {
      wrappersByChain.set(cli.chainId, cli.gaslessShieldWrapperClient);
    }
  }

  // Initialize privacy relay. Multi-chain — receives requests from any configured chain,
  // dispatches via the right provider, fee-verifies via the right path.
  console.log("[armada] Initializing privacy relay...");
  const privacyRelay = new PrivacyRelay(
    walletManager,
    feeCalculators,
    allowedTargetsByChain,
    {
      wallet: railgunWallet.getWallet(),
      privacyPoolAddress: hubAddresses.privacyPool,
      hubChainId: netConfig.hub.chainId,
      usdcAddress: hubAddresses.usdc,
    },
    { wrappersByChain },
    counters,
  );

  // Initialize CCTP relay module — select based on CCTP mode. `getHealth` is the contract
  // surfaced to http-api for the /health endpoint; both iris and cctp modules implement it.
  let cctpRelayModule: {
    start: () => void;
    stop: () => void;
    chainCount: number;
    getHealth: () => RelayerHealth;
  };

  if (armadaRelayerSettings.cctpReal) {
    console.log("[armada] Initializing REAL CCTP relay (Iris attestation)...");
    const irisRelay = new IrisRelayModule(nonceCoordinator, counters);
    const initialized = await irisRelay.initialize();
    if (!initialized) {
      console.warn("[armada] Some chains failed to initialize for Iris relay.");
    }
    cctpRelayModule = irisRelay;
  } else {
    console.log("[armada] Initializing MOCK CCTP relay module...");
    const cctpRelay = new CCTPRelayModule(nonceCoordinator, async () => {
      // CCTP mock relay reads from the hub schedule today — keeps existing behaviour.
      const hubCalc = feeCalculators.get(hubChain.chainId)!;
      const fees = await hubCalc.getCurrentFees();
      const shieldFee = BigInt(fees.fees.crossChainShield);
      const unshieldFee = BigInt(fees.fees.crossChainUnshield);
      return shieldFee < unshieldFee ? shieldFee : unshieldFee;
    });
    const initialized = await cctpRelay.initialize();
    if (!initialized) {
      console.warn("[armada] Some CCTP chains failed to initialize.");
    }
    cctpRelayModule = cctpRelay;
  }

  // A partial init (some chains failed) is a warning above and the relay runs on the chains that
  // did come up. But ZERO chains means the CCTP relay is completely dead — the process would run
  // looking partly alive (HTTP up) while silently relaying nothing. Treat that as fatal so
  // monitoring (systemd/k8s) restarts it rather than masking the outage.
  if (cctpRelayModule.chainCount === 0) {
    console.error(
      "[armada] FATAL: no CCTP chains initialized — the relay would run delivering nothing. " +
        "Check RPC connectivity and deployment files. Exiting.",
    );
    process.exit(1);
  }
  console.log();

  // Initialize HTTP API — constructed AFTER cctpRelayModule so the /health closure can bind to
  // it directly. No lazy-getter indirection, no init-order race window.
  const httpApi = new HttpApi(
    armadaRelayerSettings.port,
    privacyRelay,
    feeCalculators,
    hubChain.chainId,
    () => cctpRelayModule.getHealth(),
    counters,
  );

  // Start HTTP server
  await httpApi.start();

  // Start CCTP relay polling (background)
  cctpRelayModule.start();

  console.log();
  console.log("=".repeat(60));
  console.log("  ARMADA RELAYER RUNNING");
  console.log(`  Mode: ${armadaRelayerSettings.cctpReal ? "REAL CCTP (Iris)" : "MOCK CCTP"}`);
  console.log("=".repeat(60));
  console.log();
  console.log("Services:");
  console.log(`  Privacy Relay:  http://localhost:${armadaRelayerSettings.port}/relay`);
  console.log(`  Fee API:        http://localhost:${armadaRelayerSettings.port}/fees`);
  console.log(`  CCTP Relay:     Polling ${cctpRelayModule.chainCount} chain(s)`);
  console.log();

  // Periodic dedup cache cleanup (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    walletManager.cleanDedupCache();
  }, 5 * 60 * 1000);

  // Handle graceful shutdown. CRITICAL: await `cctpRelayModule.stop()` BEFORE process.exit so
  // the in-flight poll tick completes and its cursor write lands on disk. Previously this was
  // fire-and-forget + immediate exit, which meant a SIGTERM mid-scan could kill the process
  // between the cursor advance and the cursor write — defeating the whole point of persistent
  // cursors. Re-entrancy guarded so a second signal during shutdown doesn't double-fire.
  //
  // Safety timeout (`SHUTDOWN_FORCE_EXIT_MS`): if `stop()` itself hangs — wedged RPC mid-poll
  // with no timeout configured, infinite loop in a cleanup path, etc. — the process would
  // otherwise be unkillable without `kill -9`. The force-exit guard fires unconditionally
  // after the budget and exits with code 1 so monitoring (systemd, k8s) treats it as failure.
  const SHUTDOWN_FORCE_EXIT_MS = 60_000;
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\n[armada] Shutting down...");
    const forceExit = setTimeout(() => {
      console.error(
        `[armada] Shutdown exceeded ${SHUTDOWN_FORCE_EXIT_MS}ms — forcing exit. Some state may not have been flushed.`,
      );
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();
    clearInterval(cleanupInterval);
    try {
      await cctpRelayModule.stop();
    } catch (err) {
      console.error("[armada] Error during CCTP relay shutdown:", err);
    }
    try {
      await httpApi.stop();
    } catch (err) {
      console.error("[armada] Error during HTTP API shutdown:", err);
    }
    try {
      await railgunWallet.shutdown();
    } catch (err) {
      console.error("[armada] Error during Railgun engine shutdown:", err);
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((e) => {
  console.error("[armada] Fatal error:", e);
  process.exit(1);
});
