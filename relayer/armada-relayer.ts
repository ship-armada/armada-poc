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
import { HttpApi } from "./modules/http-api";
import { CCTPRelayModule } from "./modules/cctp-relay";
import { IrisRelayModule } from "./modules/iris-relay";
import type { PrivacyPoolDeployment, CCTPDeployment } from "./types";
import { getNetworkConfig } from "../config/networks";

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

  // Initialize fee calculator
  console.log("[armada] Initializing fee calculator...");
  const feeCalculator = new FeeCalculator(walletManager);
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

  // Initialize privacy relay
  console.log("[armada] Initializing privacy relay...");
  const privacyRelay = new PrivacyRelay(walletManager, feeCalculator, {
    privacyPool: contracts.privacyPool,
    armadaYieldAdapter: contracts.armadaYieldAdapter,
  });

  // Initialize HTTP API
  const httpApi = new HttpApi(
    armadaRelayerSettings.port,
    privacyRelay,
    feeCalculator
  );

  // Initialize CCTP relay module — select based on CCTP mode
  let cctpRelayModule: { start: () => void; stop: () => void; chainCount: number };

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

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\n[armada] Shutting down...");
    clearInterval(cleanupInterval);
    cctpRelayModule.stop();
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
