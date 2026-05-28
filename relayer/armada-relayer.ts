/**
 * Armada Relayer — Entry Point
 *
 * Unified relayer service that handles:
 * 1. Privacy Relay: Submit shielded transactions on behalf of users
 * 2. CCTP Relay: Forward cross-chain CCTP messages between all chains
 *
 * Environment-aware:
 *   - Local (CCTP_MODE=mock): Uses mock message relay with no attestation
 *   - Testnet (CCTP_MODE=real): Uses Circle's Iris attestation service
 *
 * Loads contract addresses from deployment JSONs and starts all modules.
 */

import * as fs from "fs";
import * as path from "path";
import { armadaRelayerSettings } from "./config";
import { WalletManager } from "./modules/wallet-manager";
import { FeeCalculator } from "./modules/fee-calculator";
import { PrivacyRelay } from "./modules/privacy-relay";
import { RelayerRailgunWallet } from "./modules/railgun-wallet";
import { HttpApi } from "./modules/http-api";
import { CCTPRelayModule } from "./modules/cctp-relay";
import { IrisRelayModule } from "./modules/iris-relay";
import type { PrivacyPoolDeployment, CCTPDeployment, RelayerHealth } from "./types";
import { getNetworkConfig } from "../config/networks";
import { installBisectingGetLogs } from "./lib/rpc-bisecting";

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

interface ContractAddresses {
  privacyPool: string;
  armadaYieldAdapter: string;
  usdc: string;
  messageTransmitter: string;
  tokenMessenger: string;
}

function loadContractAddresses(): ContractAddresses {
  const netConfig = getNetworkConfig();
  const suffix = netConfig.env === "local" ? "" : `-${netConfig.env}`;

  // Load privacy pool hub deployment
  const ppFile = `privacy-pool-hub${suffix}.json`;
  const ppDeployment = loadJson<PrivacyPoolDeployment>(ppFile);
  if (!ppDeployment) {
    throw new Error(
      `${ppFile} not found. Run deployment scripts first.`
    );
  }

  // Load yield deployment for ArmadaYieldAdapter
  const yieldFile = `yield-hub${suffix}.json`;
  const yieldDeployment = loadJson<YieldDeployment>(yieldFile);
  if (!yieldDeployment?.contracts?.armadaYieldAdapter) {
    throw new Error(
      `${yieldFile} with armadaYieldAdapter not found. Run deploy_yield.ts first.`
    );
  }

  // Load CCTP hub deployment
  const cctpFile = `hub${suffix}-v3.json`;
  const cctpDeployment = loadJson<CCTPDeployment>(cctpFile);
  if (!cctpDeployment) {
    throw new Error(
      `${cctpFile} not found. Run deployment scripts first.`
    );
  }

  return {
    privacyPool: ppDeployment.contracts.privacyPool,
    armadaYieldAdapter: yieldDeployment.contracts.armadaYieldAdapter,
    usdc: cctpDeployment.contracts.usdc,
    messageTransmitter: cctpDeployment.contracts.messageTransmitter,
    tokenMessenger: cctpDeployment.contracts.tokenMessenger,
  };
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

  // Load contract addresses
  console.log("[armada] Loading deployment configuration...");
  let contracts: ContractAddresses;
  try {
    contracts = loadContractAddresses();
  } catch (e: any) {
    console.error(`[armada] ${e.message}`);
    process.exit(1);
  }

  console.log("[armada] Contract addresses:");
  console.log(`  PrivacyPool:        ${contracts.privacyPool}`);
  console.log(`  ArmadaYieldAdapter: ${contracts.armadaYieldAdapter}`);
  console.log(`  USDC:               ${contracts.usdc}`);
  console.log(`  MessageTransmitter: ${contracts.messageTransmitter}`);
  console.log(`  TokenMessenger:     ${contracts.tokenMessenger}`);
  console.log();

  // Initialize wallet manager
  console.log("[armada] Initializing wallet manager...");
  const walletManager = new WalletManager();
  await walletManager.initialize();
  console.log();

  // Initialize the relayer's Railgun (0zk) wallet — engine boot + mnemonic-derived wallet.
  // MUST precede FeeCalculator so the derived address is published on `/fees` from the first
  // request, and MUST precede PrivacyRelay so broadcaster-fee verification has a viewing key.
  // Fail fast on misconfiguration (missing mnemonic, mismatching env address) — operators see
  // a clear startup error rather than a silently-broken service.
  console.log("[armada] Initializing relayer Railgun wallet...");
  const railgunWallet = new RelayerRailgunWallet();
  const { walletId: railgunWalletId, railgunAddress } = await railgunWallet.initialize();
  console.log(`  Wallet ID: ${railgunWalletId.slice(0, 16)}...`);
  console.log(`  Broadcaster address: ${railgunAddress}`);
  console.log();

  // Initialize fee calculator (now that we have the derived broadcaster address to publish)
  console.log("[armada] Initializing fee calculator...");
  const feeCalculator = new FeeCalculator(walletManager, railgunAddress);
  const initialFees = await feeCalculator.generateFeeSchedule();
  console.log("[armada] Initial fee schedule:");
  console.log(`  Transfer:           ${FeeCalculator.formatUsdcFee(initialFees.fees.transfer)}`);
  console.log(`  Unshield:           ${FeeCalculator.formatUsdcFee(initialFees.fees.unshield)}`);
  console.log(`  Cross-contract:     ${FeeCalculator.formatUsdcFee(initialFees.fees.crossContract)}`);
  console.log(`  Cross-chain shield: ${FeeCalculator.formatUsdcFee(initialFees.fees.crossChainShield)}`);
  console.log(`  Cross-chain unshield: ${FeeCalculator.formatUsdcFee(initialFees.fees.crossChainUnshield)}`);
  console.log(`  Cache ID:           ${initialFees.cacheId}`);
  console.log(`  Expires:            ${new Date(initialFees.expiresAt).toISOString()}`);
  console.log();

  // Initialize privacy relay — verifier context binds the loaded Railgun wallet, hub chain ID,
  // PrivacyPool address, and USDC address so per-request fee verification has everything it
  // needs without re-reading config.
  console.log("[armada] Initializing privacy relay...");
  const privacyRelay = new PrivacyRelay(
    walletManager,
    feeCalculator,
    {
      privacyPool: contracts.privacyPool,
      armadaYieldAdapter: contracts.armadaYieldAdapter,
    },
    {
      wallet: railgunWallet.getWallet(),
      privacyPoolAddress: contracts.privacyPool,
      hubChainId: netConfig.hub.chainId,
      usdcAddress: contracts.usdc,
    },
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
    const irisRelay = new IrisRelayModule();
    const initialized = await irisRelay.initialize();
    if (!initialized) {
      console.warn("[armada] Some chains failed to initialize for Iris relay.");
    }
    cctpRelayModule = irisRelay;
  } else {
    console.log("[armada] Initializing MOCK CCTP relay module...");
    const cctpRelay = new CCTPRelayModule(async () => {
      const fees = await feeCalculator.getCurrentFees();
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
  console.log();

  // Initialize HTTP API — constructed AFTER cctpRelayModule so the /health closure can bind to
  // it directly. No lazy-getter indirection, no init-order race window.
  const httpApi = new HttpApi(
    armadaRelayerSettings.port,
    privacyRelay,
    feeCalculator,
    () => cctpRelayModule.getHealth(),
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
    // `unref` so the timer itself doesn't keep the event loop alive if shutdown completes
    // quickly. Otherwise a happy-path shutdown would wait the full 60s for the timer.
    forceExit.unref();
    clearInterval(cleanupInterval);
    try {
      await cctpRelayModule.stop();
    } catch (err) {
      console.error("[armada] Error during CCTP relay shutdown:", err);
    }
    try {
      httpApi.stop();
    } catch (err) {
      console.error("[armada] Error during HTTP API shutdown:", err);
    }
    try {
      // Releases the LevelDB single-process lock so a subsequent boot (or test run) can open
      // the engine without hitting "LOCK already held".
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
