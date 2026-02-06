/**
 * Armada Relayer — Entry Point
 *
 * Unified relayer service that handles:
 * 1. Privacy Relay: Submit shielded transactions on behalf of users
 * 2. CCTP Relay: Forward cross-chain CCTP messages between all chains
 *
 * Loads contract addresses from deployment JSONs and starts all modules.
 */

import * as fs from "fs";
import * as path from "path";
import { armadaRelayerSettings } from "./config";
import { WalletManager } from "./modules/wallet-manager";
import { FeeCalculator } from "./modules/fee-calculator";
import { PrivacyRelay } from "./modules/privacy-relay";
import { HttpApi } from "./modules/http-api";
import { CCTPRelayModule } from "./modules/cctp-relay";
import type { PrivacyPoolDeployment, CCTPDeployment } from "./types";

// ============ Deployment Loading ============

function loadJson<T>(filename: string): T | null {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const filePath = path.join(deploymentsDir, filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

interface ContractAddresses {
  privacyPool: string;
  relayAdapt: string;
  usdc: string;
  messageTransmitter: string;
  tokenMessenger: string;
}

function loadContractAddresses(): ContractAddresses {
  // Load privacy pool hub deployment
  const ppDeployment = loadJson<PrivacyPoolDeployment>("privacy-pool-hub.json");
  if (!ppDeployment) {
    throw new Error(
      "privacy-pool-hub.json not found. Run 'npm run setup' to deploy contracts."
    );
  }

  // Load CCTP hub deployment
  const cctpDeployment = loadJson<CCTPDeployment>("hub-v3.json");
  if (!cctpDeployment) {
    throw new Error(
      "hub-v3.json not found. Run 'npm run setup' to deploy contracts."
    );
  }

  return {
    privacyPool: ppDeployment.contracts.privacyPool,
    relayAdapt: ppDeployment.contracts.relayAdapt,
    usdc: cctpDeployment.contracts.usdc,
    messageTransmitter: cctpDeployment.contracts.messageTransmitter,
    tokenMessenger: cctpDeployment.contracts.tokenMessenger,
  };
}

// ============ Main ============

async function main() {
  console.log("=".repeat(60));
  console.log("  ARMADA RELAYER");
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
  console.log(`  RelayAdapt:         ${contracts.relayAdapt}`);
  console.log(`  USDC:               ${contracts.usdc}`);
  console.log(`  MessageTransmitter: ${contracts.messageTransmitter}`);
  console.log(`  TokenMessenger:     ${contracts.tokenMessenger}`);
  console.log();

  // Initialize wallet manager
  console.log("[armada] Initializing wallet manager...");
  const walletManager = new WalletManager();
  await walletManager.initialize();
  console.log();

  // Initialize fee calculator
  console.log("[armada] Initializing fee calculator...");
  const feeCalculator = new FeeCalculator(walletManager);
  const initialFees = await feeCalculator.generateFeeSchedule();
  console.log("[armada] Initial fee schedule:");
  console.log(`  Transfer:           ${FeeCalculator.formatUsdcFee(initialFees.fees.transfer)}`);
  console.log(`  Unshield:           ${FeeCalculator.formatUsdcFee(initialFees.fees.unshield)}`);
  console.log(`  Cross-contract:     ${FeeCalculator.formatUsdcFee(initialFees.fees.crossContract)}`);
  console.log(`  Cross-chain shield: ${FeeCalculator.formatUsdcFee(initialFees.fees.crossChainShield)}`);
  console.log(`  Cache ID:           ${initialFees.cacheId}`);
  console.log(`  Expires:            ${new Date(initialFees.expiresAt).toISOString()}`);
  console.log();

  // Initialize privacy relay
  console.log("[armada] Initializing privacy relay...");
  const privacyRelay = new PrivacyRelay(walletManager, feeCalculator, {
    privacyPool: contracts.privacyPool,
    relayAdapt: contracts.relayAdapt,
  });

  // Initialize HTTP API
  const httpApi = new HttpApi(
    armadaRelayerSettings.port,
    privacyRelay,
    feeCalculator
  );

  // Initialize CCTP relay module (with fee validation from fee calculator)
  console.log("[armada] Initializing CCTP relay module...");
  const cctpRelay = new CCTPRelayModule(async () => {
    const fees = await feeCalculator.getCurrentFees();
    return BigInt(fees.fees.crossChainShield);
  });
  const cctpInitialized = await cctpRelay.initialize();
  if (!cctpInitialized) {
    console.warn(
      "[armada] Some CCTP chains failed to initialize. " +
        "Cross-chain relay may not work for all chains."
    );
  }
  console.log();

  // Start HTTP server
  await httpApi.start();

  // Start CCTP relay polling (background)
  cctpRelay.start();

  console.log();
  console.log("=".repeat(60));
  console.log("  ARMADA RELAYER RUNNING");
  console.log("=".repeat(60));
  console.log();
  console.log("Services:");
  console.log(`  Privacy Relay:  http://localhost:${armadaRelayerSettings.port}/relay`);
  console.log(`  Fee API:        http://localhost:${armadaRelayerSettings.port}/fees`);
  console.log(`  CCTP Relay:     Polling ${cctpRelay.chainCount} chain(s)`);
  console.log();

  // Periodic dedup cache cleanup (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    walletManager.cleanDedupCache();
  }, 5 * 60 * 1000);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\n[armada] Shutting down...");
    clearInterval(cleanupInterval);
    cctpRelay.stop();
    httpApi.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[armada] Fatal error:", e);
  process.exit(1);
});
