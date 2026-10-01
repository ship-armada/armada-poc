/**
 * Unified Network Configuration
 *
 * Single source of truth for chain configs, CCTP addresses, and domain mappings.
 * Reads from environment variables (set via config/local.env or config/sepolia.env).
 *
 * Supports a hub plus an arbitrary number (N) of client chains. Client chains are
 * configured via an indexed env scheme: CLIENT_COUNT sets how many, and each client
 * n (1-based) is described by CLIENT_<n>_RPC / CLIENT_<n>_CHAIN_ID /
 * CLIENT_<n>_CCTP_DOMAIN / CLIENT_<n>_USDC.
 *
 * Usage:
 *   import { getNetworkConfig, getDeployEnv, isCCTPReal } from "../config/networks";
 *   const config = getNetworkConfig();
 */

import "dotenv/config";

// ============================================================================
// Types
// ============================================================================

export type DeployEnv = "local" | "sepolia" | "mainnet";
export type CCTPMode = "mock" | "real";
/**
 * A chain's role. The hub is unique; client chains are numbered 1..CLIENT_COUNT
 * (e.g. "client1", "client2", ...). Client roles are 1-based to match the
 * CLIENT_<n>_* env scheme and the human-facing "Client N" labels.
 */
export type ClientRole = `client${number}`;
export type ChainRole = "hub" | ClientRole;

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
  /** USDC token address on this chain (only populated when CCTP_MODE=real) */
  usdc: string;
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

/** Treasury per-token outflow rate-limit parameters (ArmadaTreasuryGov.initOutflowConfig). */
export interface OutflowParams {
  /** Rolling window length in seconds (must be >= 1 day). */
  windowDuration: number;
  /** Per-window limit as basis points of treasury balance (1..10000). */
  limitBps: number;
  /** Absolute per-window amount, in the token's smallest unit. Not a cap: the effective
   * limit is the greater of this and limitBps × balance, raised to at least floorAbsolute. */
  limitAbsolute: string;
  /** Immutable minimum the absolute amount can never be reduced below, smallest unit. */
  floorAbsolute: string;
}

export interface NetworkConfig {
  env: DeployEnv;
  cctpMode: CCTPMode;
  deployerPrivateKey: string;
  hub: ChainConfig;
  /** Client chains, in order (client1, client2, ...). Length == CLIENT_COUNT. */
  clients: ChainConfig[];
  /**
   * Shared CCTP infrastructure addresses. On EVM testnets/mainnet Circle deploys the
   * TokenMessenger/MessageTransmitter/TokenMinter at the same address on every chain
   * (via CREATE2), so these are chain-agnostic. Per-chain USDC lives on ChainConfig.usdc.
   * Only populated when CCTP_MODE=real.
   */
  cctpShared: {
    tokenMessenger: string;
    messageTransmitter: string;
    tokenMinter: string;
  };
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
  /**
   * Optional PrivacyPool fee-recipient override (TREASURY_ADDRESS). If empty, the pool uses
   * ArmadaTreasuryGov from the governance manifest (deployer on local). Refused on mainnet.
   */
  treasuryAddress: string;
  /**
   * ARM token distribution (12M total supply).
   * All values are whole-token counts (no decimals). The deployer retains the remainder.
   *   Treasury:    7.8M — protocol treasury (65%)
   *   Crowdfund:   1.8M — backs MAX_SALE at $1/ARM
   *   RevenueLock: 2.4M — team, advisors, airdrop and optional reserve (20% combined)
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
  /** Optional reserve within the RevenueLock total. With a reserve enabled, the
   * beneficiary list above contains only direct recipients (total minus reserve).
   * Both fields must be explicitly set; neither a Safe nor an amount is invented. */
  revenueReserve?: { allocator: string; amount: string };
  /** Security council address for crowdfund cancel authority. Required for non-local. */
  securityCouncilAddress: string;
  /** Launch team address — issues crowdfund seeds and direct invites during the
   *  window. Kept separate from the deployer to limit deployer-key exposure once
   *  the deployer's privileges are renounced post-deploy. Required for non-local. */
  launchTeamAddress: string;
  /** Crowdfund open delay in seconds from deployment time. Default 600 (10 minutes) —
   *  an operational buffer that lets the post-deploy verification checklist complete
   *  before commits can flow. Used only when crowdfundOpenTime is unset (local/Sepolia). */
  crowdfundOpenDelay: number;
  /** Absolute crowdfund open time as ISO 8601 UTC ("2026-10-08T17:00:00Z"). Required on
   *  mainnet (CROWDFUND_OPEN_TIME) so the immutable windowStart matches the announced
   *  launch; optional override on local/Sepolia. Format and lead time are validated by
   *  resolveCrowdfundOpenTimestamp (scripts/deploy-utils.ts). */
  crowdfundOpenTime: string | undefined;
  /** Wind-down deadline as ISO 8601 date string. Required on mainnet (WINDDOWN_DEADLINE);
   *  local/Sepolia default "2027-12-31T00:00:00Z". */
  windDownDeadline: string;
  /** Wind-down revenue threshold in whole USD (18-decimal). Required on mainnet
   *  (WINDDOWN_REVENUE_THRESHOLD); local/Sepolia default "10000". */
  windDownRevenueThreshold: string;
  /** RevenueLock MAX_REVENUE_INCREASE_PER_DAY in whole USD, scaled to 18 decimals at deploy
   *  (RevenueCounter.recognizedRevenueUsd is 18-decimal USD). Immutable per RevenueLock.
   *  Default "10000" ($10k/day — issue #225: a malicious RevenueCounter upgrade needs
   *  >= 100 days to walk $0 -> $1M full unlock). Env: REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD. */
  revenueLockMaxIncreasePerDayUsd: string;
  /** CCTP finality mode: "fast" (confirmed, ~8-20s) or "standard" (finalized, ~15-19min) */
  cctpFinalityMode: "fast" | "standard";
  /**
   * Timelock harden profile. When true, the deploy bootstraps timelock-only wiring
   * itself — deploy the timelock with minDelay 0, temporarily grant the deployer
   * PROPOSER/EXECUTOR/CANCELLER, run all timelock-only setup, raise the delay to its
   * production value, then renounce all deployer timelock roles. Used for mainnet (and
   * the Sepolia production-like dry-run, #319). Defaults to true on mainnet, false
   * elsewhere. See issue #347.
   */
  hardenTimelock: boolean;
  /**
   * Treasury outflow rate-limit config per token, applied at deploy via
   * initOutflowConfig so the treasury is protected from launch rather than via a
   * fragile first governance vote. Values follow GOVERNANCE.md (issue #348). Amounts are in each token's smallest unit (USDC 6dp, ARM/ETH 18dp).
   */
  outflowConfig: { usdc: OutflowParams; arm: OutflowParams; eth: OutflowParams };
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

/** Upper bound for the RevenueLock ratchet rate: the $1M full-unlock milestone. A larger
 *  per-day cap would let one day's sync unlock everything, i.e. no cap at all. */
const REVENUE_LOCK_FULL_UNLOCK_USD = 1_000_000n;

/**
 * Read the RevenueLock ratchet rate cap as a positive whole-USD integer string. Rejects
 * decimals, exponents and pre-scaled 18-decimal values (anything above the $1M full-unlock
 * milestone): RevenueLock has no setter, so a scale mistake must fail before deploy.
 */
function revenueLockMaxIncreaseEnv(key: string, defaultValue: string): string {
  const value = optionalEnv(key, defaultValue);
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > REVENUE_LOCK_FULL_UNLOCK_USD) {
    throw new Error(
      `${key} must be a whole-USD integer between 1 and ${REVENUE_LOCK_FULL_UNLOCK_USD} ` +
      `(not 18-decimal scaled), got "${value}"`
    );
  }
  return value;
}

function boolEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === "") return defaultValue;
  return value === "true" || value === "1";
}

// ============================================================================
// Client Chain Builder
// ============================================================================

/**
 * Build the ordered list of client chain configs from the indexed env scheme.
 *
 * CLIENT_COUNT sets how many clients (default 2). Client n (1-based) reads
 * CLIENT_<n>_RPC / CLIENT_<n>_CHAIN_ID / CLIENT_<n>_CCTP_DOMAIN / CLIENT_<n>_USDC,
 * plus an optional CLIENT_<n>_NAME label. For local dev, sensible Anvil defaults are
 * provided for the first two clients so the chain topology works without explicit env.
 */
function buildClients(env: DeployEnv): ChainConfig[] {
  // Local defaults for the first two Anvil client chains (ports 8546/8547).
  const localDefaults: Array<{ rpc: string; chainId: number; cctpDomain: number }> = [
    { rpc: "http://localhost:8546", chainId: 31338, cctpDomain: 101 },
    { rpc: "http://localhost:8547", chainId: 31339, cctpDomain: 102 },
  ];

  const count = numEnv("CLIENT_COUNT", env === "local" ? 2 : 0);
  if (count < 1) {
    throw new Error(
      `CLIENT_COUNT must be >= 1 (got ${count}). Configure at least one client chain.`
    );
  }

  const clients: ChainConfig[] = [];
  for (let i = 1; i <= count; i++) {
    const def = localDefaults[i - 1];
    const rpc = env === "local" && def
      ? optionalEnv(`CLIENT_${i}_RPC`, def.rpc)
      : requireEnv(`CLIENT_${i}_RPC`);
    const chainId = env === "local" && def
      ? numEnv(`CLIENT_${i}_CHAIN_ID`, def.chainId)
      : parseInt(requireEnv(`CLIENT_${i}_CHAIN_ID`), 10);
    const cctpDomain = env === "local" && def
      ? numEnv(`CLIENT_${i}_CCTP_DOMAIN`, def.cctpDomain)
      : parseInt(requireEnv(`CLIENT_${i}_CCTP_DOMAIN`), 10);

    clients.push({
      rpc,
      chainId,
      cctpDomain,
      name: optionalEnv(`CLIENT_${i}_NAME`, `Client ${i}`),
      role: `client${i}`,
      hardhatNetwork: env === "local" ? `client${i}` : `${env}Client${i}`,
      deploymentPrefix: `client${i}`,
      usdc: optionalEnv(`CLIENT_${i}_USDC`, ""),
    });
  }
  return clients;
}

// ============================================================================
// RevenueLock Beneficiary Builder
// ============================================================================

/**
 * Build the RevenueLock beneficiary list from environment variables.
 * Local dev uses Anvil default accounts as placeholders.
 * Non-local environments require explicit configuration via either:
 *   - REVENUE_LOCK_BENEFICIARIES_FILE: path to a JSON file (preferred, avoids shell quoting issues)
 *   - REVENUE_LOCK_BENEFICIARIES_JSON: inline JSON string
 *
 * JSON format: [{"address":"0x...","amount":"1200000","label":"team member 1"}, ...]
 */
function buildRevenueLockBeneficiaries(env: DeployEnv): RevenueLockBeneficiary[] {
  const filePath = process.env.REVENUE_LOCK_BENEFICIARIES_FILE;
  const jsonStr = filePath
    ? require("fs").readFileSync(filePath, "utf-8")
    : process.env.REVENUE_LOCK_BENEFICIARIES_JSON;

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
    "RevenueLock beneficiaries required for non-local environments. " +
    "Set REVENUE_LOCK_BENEFICIARIES_FILE (path to JSON) or REVENUE_LOCK_BENEFICIARIES_JSON (inline)."
  );
}

// ============================================================================
// Config Builder
// ============================================================================

let _cachedConfig: NetworkConfig | null = null;

export function getNetworkConfig(): NetworkConfig {
  if (_cachedConfig) return _cachedConfig;

  const reserveAllocator = process.env.REVENUE_RESERVE_ALLOCATOR?.trim();
  const reserveAmount = process.env.REVENUE_RESERVE_AMOUNT?.trim();
  if (Boolean(reserveAllocator) !== Boolean(reserveAmount)) {
    throw new Error("Set both REVENUE_RESERVE_ALLOCATOR and REVENUE_RESERVE_AMOUNT, or neither");
  }

  const env = (optionalEnv("DEPLOY_ENV", "local")) as DeployEnv;
  const cctpMode = (optionalEnv("CCTP_MODE", "mock")) as CCTPMode;

  // Reject a typo'd or unknown DEPLOY_ENV rather than letting it silently behave
  // like an unconfigured environment (e.g. a misspelled "mainnet" must not slip through).
  const VALID_ENVS: ReadonlyArray<DeployEnv> = ["local", "sepolia", "mainnet"];
  if (!VALID_ENVS.includes(env)) {
    throw new Error(`Invalid DEPLOY_ENV "${env}". Must be one of: ${VALID_ENVS.join(", ")}`);
  }

  // Mainnet must never run against mock CCTP — that would deploy a fake USDC and
  // mock bridge against a production deployment. Fail loud.
  if (env === "mainnet" && cctpMode !== "real") {
    throw new Error('CCTP_MODE must be "real" on mainnet (refusing to deploy mock CCTP/USDC).');
  }

  // The PrivacyPool fee recipient is fixed at initialize(). On mainnet it must be the
  // governance treasury (ArmadaTreasuryGov) so protocol fees stay under governance
  // control — refuse an override rather than divert fees to another address for good.
  const treasuryAddress = process.env.TREASURY_ADDRESS?.trim() ?? "";
  if (env === "mainnet" && treasuryAddress) {
    throw new Error(
      "TREASURY_ADDRESS must not be set on mainnet: the privacy pool fee recipient is the " +
      "governance treasury (ArmadaTreasuryGov) from the governance manifest."
    );
  }

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
    hardhatNetwork: env === "local" ? "hub" : `${env}Hub`,
    deploymentPrefix: "hub",
    usdc: optionalEnv("HUB_USDC", ""),
  };

  const clients = buildClients(env);

  // CCTP infrastructure addresses (same contract addresses on all EVM testnets via CREATE2)
  const cctpShared = {
    tokenMessenger: optionalEnv("CCTP_TOKEN_MESSENGER", ""),
    messageTransmitter: optionalEnv("CCTP_MESSAGE_TRANSMITTER", ""),
    tokenMinter: optionalEnv("CCTP_TOKEN_MINTER", ""),
  };

  // RevenueLock beneficiaries: local uses Anvil defaults, non-local requires explicit config
  const revenueLockBeneficiaries = buildRevenueLockBeneficiaries(env);

  _cachedConfig = {
    env,
    cctpMode,
    deployerPrivateKey,
    hub,
    clients,
    cctpShared,
    iris: {
      apiUrl: optionalEnv("IRIS_API_URL", "https://iris-api-sandbox.circle.com"),
      pollIntervalMs: numEnv("IRIS_POLL_INTERVAL_MS", 10000),
      pollTimeoutMs: numEnv("IRIS_POLL_TIMEOUT_MS", 600000),
    },
    // Default 5,000,000 bps (50,000% APY) is intentionally high for local fast-forward testing.
    // Sepolia overrides to 50,000 bps (500%). Production must set an appropriate value.
    aaveYieldBps: numEnv("AAVE_YIELD_BPS", 5000000),
    timelockDelay: numEnv("TIMELOCK_DELAY", 172800),
    relayerPort: numEnv("RELAYER_PORT", 3001),
    ethUsdcPrice: numEnv("ETH_USDC_PRICE", 2000),
    treasuryAddress,
    armDistribution: {
      treasury: optionalEnv("ARM_TREASURY_ALLOCATION", "7800000"),
      crowdfund: optionalEnv("ARM_CROWDFUND_ALLOCATION", "1800000"),
      revenueLock: optionalEnv("ARM_REVENUE_LOCK_ALLOCATION", "2400000"),
    },
    revenueLockBeneficiaries,
    revenueReserve: reserveAllocator && reserveAmount
      ? { allocator: reserveAllocator, amount: reserveAmount }
      : undefined,
    securityCouncilAddress: optionalEnv("SECURITY_COUNCIL_ADDRESS", ""),
    launchTeamAddress: optionalEnv("LAUNCH_TEAM_ADDRESS", ""),
    crowdfundOpenDelay: numEnv("CROWDFUND_OPEN_DELAY", 600),
    // No mainnet default: windowStart is immutable, and a relative delay drifts with how long
    // the earlier deploy steps take, so the announced open time must be stated explicitly.
    crowdfundOpenTime: env === "mainnet"
      ? requireEnv("CROWDFUND_OPEN_TIME")
      : process.env.CROWDFUND_OPEN_TIME || undefined,
    // No mainnet default: the deadline arms the permissionless, terminal wind-down trigger
    // and is fixed at the crowdfund deploy, so it must be chosen deliberately (#381 C2).
    windDownDeadline: env === "mainnet"
      ? requireEnv("WINDDOWN_DEADLINE")
      : optionalEnv("WINDDOWN_DEADLINE", "2027-12-31T00:00:00Z"),
    // Paired with the deadline: below-threshold revenue after it arms the terminal trigger,
    // so mainnet takes no default either.
    windDownRevenueThreshold: env === "mainnet"
      ? requireEnv("WINDDOWN_REVENUE_THRESHOLD")
      : optionalEnv("WINDDOWN_REVENUE_THRESHOLD", "10000"),
    revenueLockMaxIncreasePerDayUsd: revenueLockMaxIncreaseEnv("REVENUE_LOCK_MAX_INCREASE_PER_DAY_USD", "10000"),
    cctpFinalityMode: optionalEnv("CCTP_FINALITY_MODE", "fast") as "fast" | "standard",
    // Default on for mainnet (safe — can't forget to harden), opt-in elsewhere
    // (the Sepolia dry-run sets HARDEN_TIMELOCK=true to rehearse the mainnet path).
    hardenTimelock: boolEnv("HARDEN_TIMELOCK", env === "mainnet"),
    // Treasury outflow limits, env-overridable per token. Defaults are the GOVERNANCE.md
    // §Treasury Outflow Limits values: 30-day rolling window, limit = greater of the
    // absolute amount and the % of treasury balance, immutable floor.
    outflowConfig: {
      usdc: {
        windowDuration: numEnv("OUTFLOW_USDC_WINDOW", 2592000),                         // 30 days
        limitBps: numEnv("OUTFLOW_USDC_BPS", 1000),                                     // 10%
        limitAbsolute: optionalEnv("OUTFLOW_USDC_ABSOLUTE", "100000000000"),            // 100,000 USDC (6dp)
        floorAbsolute: optionalEnv("OUTFLOW_USDC_FLOOR", "50000000000"),                // 50,000 USDC (6dp)
      },
      arm: {
        windowDuration: numEnv("OUTFLOW_ARM_WINDOW", 2592000),                          // 30 days
        limitBps: numEnv("OUTFLOW_ARM_BPS", 300),                                       // 3%
        limitAbsolute: optionalEnv("OUTFLOW_ARM_ABSOLUTE", "250000000000000000000000"), // 250,000 ARM (18dp)
        floorAbsolute: optionalEnv("OUTFLOW_ARM_FLOOR", "100000000000000000000000"),    // 100,000 ARM (18dp)
      },
      eth: {
        windowDuration: numEnv("OUTFLOW_ETH_WINDOW", 2592000),                          // 30 days
        limitBps: numEnv("OUTFLOW_ETH_BPS", 1000),                                      // 10%
        limitAbsolute: optionalEnv("OUTFLOW_ETH_ABSOLUTE", "25000000000000000000"),     // 25 ETH (18dp)
        floorAbsolute: optionalEnv("OUTFLOW_ETH_FLOOR", "0"),                           // none (raisable)
      },
    },
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
  return getAllChains().find((c) => c.chainId === chainId);
}

/** Get chain config by CCTP domain ID */
export function getChainByDomain(domain: number): ChainConfig | undefined {
  return getAllChains().find((c) => c.cctpDomain === domain);
}

/** Get chain config by role */
export function getChainByRole(role: ChainRole): ChainConfig {
  const chain = getAllChains().find((c) => c.role === role);
  if (!chain) {
    throw new Error(`No chain configured for role "${role}"`);
  }
  return chain;
}

/** Get all chain configs (hub first, then clients in order) */
export function getAllChains(): ChainConfig[] {
  const config = getNetworkConfig();
  return [config.hub, ...config.clients];
}

/** Get all client chain configs (excludes the hub) */
export function getClientChains(): ChainConfig[] {
  return getNetworkConfig().clients;
}

/** Get CCTP addresses for a chain role (shared infra + that chain's USDC) */
export function getCCTPAddresses(role: ChainRole): CCTPAddresses {
  const config = getNetworkConfig();
  const chain = getChainByRole(role);
  return {
    tokenMessenger: config.cctpShared.tokenMessenger,
    messageTransmitter: config.cctpShared.messageTransmitter,
    tokenMinter: config.cctpShared.tokenMinter,
    usdc: chain.usdc,
  };
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
 * Get the fee module deployment filename.
 */
export function getFeeModuleDeploymentFile(): string {
  const config = getNetworkConfig();
  const suffix = config.env === "local" ? "" : `-${config.env}`;
  return `fee-module-hub${suffix}.json`;
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
  return getChainByChainId(chainId)?.role ?? null;
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

  const addrs = getCCTPAddresses(role);
  if (!addrs.tokenMessenger) throw new Error(`CCTP_TOKEN_MESSENGER not set`);
  if (!addrs.messageTransmitter) throw new Error(`CCTP_MESSAGE_TRANSMITTER not set`);
  if (!addrs.usdc) {
    const chain = getChainByRole(role);
    throw new Error(`USDC address not set for ${chain.name} (${role})`);
  }
}
