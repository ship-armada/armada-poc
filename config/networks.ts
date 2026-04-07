/**
 * Unified Network Configuration
 *
 * Single source of truth for chain configs, CCTP addresses, and domain mappings.
 * Reads from environment variables (set via config/local.env or config/sepolia.env).
 *
 * Usage:
 *   import { getNetworkConfig, getDeployEnv, isCCTPReal } from "../config/networks";
 *   const config = getNetworkConfig();
 */

import "dotenv/config";

// ============================================================================
// Types
// ============================================================================

export type DeployEnv = "local" | "sepolia";
export type CCTPMode = "mock" | "real";
export type ChainRole = "hub" | "clientA" | "clientB";

export interface ChainConfig {
  rpc: string;
  chainId: number;
  cctpDomain: number;
  name: string;
  role: ChainRole;
  /** Hardhat network name for this chain */
  hardhatNetwork: string;
  /** Deployment JSON filename prefix */
  deploymentPrefix: string;
}

export interface CCTPAddresses {
  tokenMessenger: string;
  messageTransmitter: string;
  tokenMinter: string;
  usdc: string;
}

export interface RevenueLockBeneficiary {
  address: string;
  amount: string;  // whole-token count (no decimals)
  label: string;   // human-readable label for deploy logs
}

export interface NetworkConfig {
  env: DeployEnv;
  cctpMode: CCTPMode;
  deployerPrivateKey: string;
  hub: ChainConfig;
  clientA: ChainConfig;
  clientB: ChainConfig;
  /** CCTP addresses per chain role (only populated when CCTP_MODE=real) */
  cctpAddresses: Record<ChainRole, CCTPAddresses>;
  /** Iris attestation config (only used when CCTP_MODE=real) */
  iris: {
    apiUrl: string;
    pollIntervalMs: number;
    pollTimeoutMs: number;
  };
  /** Aave mock yield rate in basis points */
  aaveYieldBps: number;
  /** Governance timelock delay in seconds */
  timelockDelay: number;
  /** Relayer HTTP API port */
  relayerPort: number;
  /** Hardcoded ETH/USDC price for fee calculation */
  ethUsdcPrice: number;
  /** Optional treasury address override (if empty, deployer is used) */
  treasuryAddress: string;
  /**
   * ARM token distribution (12M total supply).
   * All values are whole-token counts (no decimals). The deployer retains the remainder.
   *   Treasury:    7.8M — protocol treasury (65%)
   *   Crowdfund:   1.8M — backs MAX_SALE at $1/ARM
   *   RevenueLock: 2.4M — team (15%) + airdrop (5%), revenue-gated release
   *   Deployer remainder: 0
   */
  armDistribution: {
    treasury: string;
    crowdfund: string;
    revenueLock: string;
  };
  /**
   * RevenueLock beneficiary list. Network-namespaced with no default for non-local
   * environments — the deploy will fail if these are not explicitly configured.
   * For local dev, Anvil default accounts are used as placeholders.
   */
  revenueLockBeneficiaries: RevenueLockBeneficiary[];
  /** CCTP finality mode: "fast" (confirmed, ~8-20s) or "standard" (finalized, ~15-19min) */
  cctpFinalityMode: "fast" | "standard";
}

// ============================================================================
// Environment Helpers
// ============================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function numEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

// ============================================================================
// RevenueLock Beneficiary Builder
// ============================================================================

/**
 * Build the RevenueLock beneficiary list from environment variables.
 * Local dev uses Anvil default accounts as placeholders.
 * Non-local environments require explicit REVENUE_LOCK_BENEFICIARIES_JSON.
 *
 * JSON format: [{"address":"0x...","amount":"1200000","label":"team member 1"}, ...]
 */
function buildRevenueLockBeneficiaries(env: DeployEnv): RevenueLockBeneficiary[] {
  const jsonStr = process.env.REVENUE_LOCK_BENEFICIARIES_JSON;

  if (jsonStr) {
    // Explicit config provided — use it on any environment
    const parsed = JSON.parse(jsonStr) as RevenueLockBeneficiary[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("REVENUE_LOCK_BENEFICIARIES_JSON must be a non-empty array");
    }
    for (const b of parsed) {
      if (!b.address || !b.amount || !b.label) {
        throw new Error(
          "Each beneficiary must have address, amount, and label fields"
        );
      }
    }
    return parsed;
  }

  if (env === "local") {
    // Anvil placeholder beneficiaries for local dev only
    return [
      { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", amount: "1200000", label: "team member 1 (Anvil #1)" },
      { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", amount: "800000", label: "team member 2 (Anvil #2)" },
      { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", amount: "400000", label: "airdrop (Anvil #3)" },
    ];
  }

  // Non-local with no explicit config — fail loud
  throw new Error(
    "REVENUE_LOCK_BENEFICIARIES_JSON is required for non-local environments. " +
    "Set it to a JSON array of {address, amount, label} objects."
  );
}

// ============================================================================
// Config Builder
// ============================================================================

let _cachedConfig: NetworkConfig | null = null;

export function getNetworkConfig(): NetworkConfig {
  if (_cachedConfig) return _cachedConfig;

  const env = (optionalEnv("DEPLOY_ENV", "local")) as DeployEnv;
  const cctpMode = (optionalEnv("CCTP_MODE", "mock")) as CCTPMode;

  // Deployer key: required for real testnets, default Anvil key for local
  const defaultKey = env === "local"
    ? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    : "";
  const deployerPrivateKey = optionalEnv("DEPLOYER_PRIVATE_KEY", defaultKey);

  if (env !== "local" && !deployerPrivateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for non-local environments");
  }

  const hub: ChainConfig = {
    rpc: optionalEnv("HUB_RPC", "http://localhost:8545"),
    chainId: numEnv("HUB_CHAIN_ID", 31337),
    cctpDomain: numEnv("HUB_CCTP_DOMAIN", 100),
    name: "Hub",
    role: "hub",
    hardhatNetwork: env === "local" ? "hub" : "sepoliaHub",
    deploymentPrefix: "hub",
  };

  const clientA: ChainConfig = {
    rpc: optionalEnv("CLIENT_A_RPC", "http://localhost:8546"),
    chainId: numEnv("CLIENT_A_CHAIN_ID", 31338),
    cctpDomain: numEnv("CLIENT_A_CCTP_DOMAIN", 101),
    name: "Client A",
    role: "clientA",
    hardhatNetwork: env === "local" ? "client" : "sepoliaClientA",
    deploymentPrefix: "client",
  };

  const clientB: ChainConfig = {
    rpc: optionalEnv("CLIENT_B_RPC", "http://localhost:8547"),
    chainId: numEnv("CLIENT_B_CHAIN_ID", 31339),
    cctpDomain: numEnv("CLIENT_B_CCTP_DOMAIN", 102),
    name: "Client B",
    role: "clientB",
    hardhatNetwork: env === "local" ? "clientB" : "sepoliaClientB",
    deploymentPrefix: "clientB",
  };

  // CCTP addresses (same contract addresses on all EVM testnets via CREATE2)
  const sharedMessenger = optionalEnv("CCTP_TOKEN_MESSENGER", "");
  const sharedTransmitter = optionalEnv("CCTP_MESSAGE_TRANSMITTER", "");
  const sharedMinter = optionalEnv("CCTP_TOKEN_MINTER", "");

  const cctpAddresses: Record<ChainRole, CCTPAddresses> = {
    hub: {
      tokenMessenger: sharedMessenger,
      messageTransmitter: sharedTransmitter,
      tokenMinter: sharedMinter,
      usdc: optionalEnv("HUB_USDC", ""),
    },
    clientA: {
      tokenMessenger: sharedMessenger,
      messageTransmitter: sharedTransmitter,
      tokenMinter: sharedMinter,
      usdc: optionalEnv("CLIENT_A_USDC", ""),
    },
    clientB: {
      tokenMessenger: sharedMessenger,
      messageTransmitter: sharedTransmitter,
      tokenMinter: sharedMinter,
      usdc: optionalEnv("CLIENT_B_USDC", ""),
    },
  };

  // RevenueLock beneficiaries: local uses Anvil defaults, non-local requires explicit config
  const revenueLockBeneficiaries = buildRevenueLockBeneficiaries(env);

  _cachedConfig = {
    env,
    cctpMode,
    deployerPrivateKey,
    hub,
    clientA,
    clientB,
    cctpAddresses,
    iris: {
      apiUrl: optionalEnv("IRIS_API_URL", "https://iris-api-sandbox.circle.com"),
      pollIntervalMs: numEnv("IRIS_POLL_INTERVAL_MS", 10000),
      pollTimeoutMs: numEnv("IRIS_POLL_TIMEOUT_MS", 600000),
    },
    aaveYieldBps: numEnv("AAVE_YIELD_BPS", 5000000),
    timelockDelay: numEnv("TIMELOCK_DELAY", 172800),
    relayerPort: numEnv("RELAYER_PORT", 3001),
    ethUsdcPrice: numEnv("ETH_USDC_PRICE", 2000),
    treasuryAddress: process.env.TREASURY_ADDRESS ?? "",
    armDistribution: {
      treasury: optionalEnv("ARM_TREASURY_ALLOCATION", "7800000"),
      crowdfund: optionalEnv("ARM_CROWDFUND_ALLOCATION", "1800000"),
      revenueLock: optionalEnv("ARM_REVENUE_LOCK_ALLOCATION", "2400000"),
    },
    revenueLockBeneficiaries,
    cctpFinalityMode: optionalEnv("CCTP_FINALITY_MODE", "fast") as "fast" | "standard",
  };

  return _cachedConfig;
}

// ============================================================================
// Convenience Accessors
// ============================================================================

export function getDeployEnv(): DeployEnv {
  return getNetworkConfig().env;
}

export function isCCTPReal(): boolean {
  return getNetworkConfig().cctpMode === "real";
}

export function isLocal(): boolean {
  return getNetworkConfig().env === "local";
}

/** Get chain config by chain ID (runtime lookup) */
export function getChainByChainId(chainId: number): ChainConfig | undefined {
  const config = getNetworkConfig();
  return [config.hub, config.clientA, config.clientB].find(
    (c) => c.chainId === chainId
  );
}

/** Get chain config by CCTP domain ID */
export function getChainByDomain(domain: number): ChainConfig | undefined {
  const config = getNetworkConfig();
  return [config.hub, config.clientA, config.clientB].find(
    (c) => c.cctpDomain === domain
  );
}

/** Get chain config by role */
export function getChainByRole(role: ChainRole): ChainConfig {
  const config = getNetworkConfig();
  switch (role) {
    case "hub": return config.hub;
    case "clientA": return config.clientA;
    case "clientB": return config.clientB;
  }
}

/** Get all chain configs */
export function getAllChains(): ChainConfig[] {
  const config = getNetworkConfig();
  return [config.hub, config.clientA, config.clientB];
}

/** Get CCTP addresses for a chain role */
export function getCCTPAddresses(role: ChainRole): CCTPAddresses {
  return getNetworkConfig().cctpAddresses[role];
}

/** Map chain ID to its CCTP domain */
export function chainIdToDomain(chainId: number): number | undefined {
  return getChainByChainId(chainId)?.cctpDomain;
}

/** Map CCTP domain to chain ID */
export function domainToChainId(domain: number): number | undefined {
  return getChainByDomain(domain)?.chainId;
}

/**
 * Get the CCTP deployment filename for a chain.
 * Format: "{prefix}-v3.json" for local, "{prefix}-sepolia-v3.json" for testnet.
 */
export function getCCTPDeploymentFile(role: ChainRole): string {
  const config = getNetworkConfig();
  const chain = getChainByRole(role);
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `${chain.deploymentPrefix}${suffix}-v3.json`;
}

/**
 * Get the privacy pool deployment filename for a chain.
 */
export function getPrivacyPoolDeploymentFile(role: ChainRole): string {
  const config = getNetworkConfig();
  const chain = getChainByRole(role);
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `privacy-pool-${chain.deploymentPrefix}${suffix}.json`;
}

/**
 * Get the yield deployment filename.
 */
export function getYieldDeploymentFile(): string {
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `yield-hub${suffix}.json`;
}

/**
 * Get the aave mock deployment filename for a chain.
 */
export function getAaveMockDeploymentFile(role: ChainRole): string {
  const config = getNetworkConfig();
  const chain = getChainByRole(role);
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `aave-mock-${chain.deploymentPrefix}${suffix}.json`;
}

/**
 * Get the governance deployment filename.
 */
export function getGovernanceDeploymentFile(): string {
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `governance-hub${suffix}.json`;
}

/**
 * Get the crowdfund deployment filename.
 */
export function getCrowdfundDeploymentFile(): string {
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `crowdfund-hub${suffix}.json`;
}

/**
 * Determine chain role from a hardhat chain ID at runtime.
 * Returns null if the chain ID doesn't match any configured chain.
 */
export function getChainRole(chainId: number): ChainRole | null {
  const config = getNetworkConfig();
  if (chainId === config.hub.chainId) return "hub";
  if (chainId === config.clientA.chainId) return "clientA";
  if (chainId === config.clientB.chainId) return "clientB";
  return null;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that all required CCTP addresses are set for real mode.
 * Call this at the start of deployment scripts when CCTP_MODE=real.
 */
export function validateCCTPConfig(role: ChainRole): void {
  const config = getNetworkConfig();
  if (config.cctpMode !== "real") return;

  const addrs = config.cctpAddresses[role];
  if (!addrs.tokenMessenger) throw new Error(`CCTP_TOKEN_MESSENGER not set`);
  if (!addrs.messageTransmitter) throw new Error(`CCTP_MESSAGE_TRANSMITTER not set`);
  if (!addrs.usdc) {
    const chain = getChainByRole(role);
    throw new Error(`USDC address not set for ${chain.name} (${role})`);
  }
}
