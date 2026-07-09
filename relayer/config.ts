import "dotenv/config";

/**
 * POC Configuration
 *
 * Multi-chain configuration for the CCTP demo.
 * Environment-aware: reads from config/networks.ts which sources from env vars.
 *
 * For local dev:   source config/local.env
 * For Sepolia:     source config/sepolia.env
 */

import {
  getNetworkConfig,
  isCCTPReal,
  isLocal,
  type ChainConfig as NetChainConfig,
} from "../config/networks";

// Re-export chain config type with deployment file for backward compat
export interface ChainConfig {
  rpc: string;
  chainId: number;
  name: string;
  deploymentFile: string;
  privacyPoolDeploymentFile: string;
  cctpDomain: number;
  /**
   * Relayer-only knobs for the CCTP scan loop. Defaults below come from the chain's
   * characteristics — finality depth (reorg risk), public-RPC range caps, etc.
   *
   * Per-knob env overrides honour the pattern `RELAYER_<KNOB>_<CHAIN_NAME_UPPER>`, where the
   * suffix derives from the chain's config `name` ("Hub", "Client A", "Client B" — NOT the
   * underlying network name). So: `RELAYER_MAX_LOG_RANGE_HUB=200`,
   * `RELAYER_CONFIRMATION_DEPTH_CLIENT_A=2`, etc. When unset, the default for the chain wins.
   */
  scanner: {
    /**
     * Reorg buffer — we scan only up to `currentBlock - confirmationDepth` so a reorg that
     * drops a MessageSent event between our detection and our relayWithHook call can't leave
     * us submitting an attestation for a vanished message. Defaults: 6 for Ethereum L1, 2 for
     * L2s (Base/Arbitrum), 0 for Anvil (no reorgs).
     */
    confirmationDepth: number;
    /**
     * Cursor-checkpoint cadence — how many blocks the scanner attempts per outer chunk before
     * persisting the cursor + ingesting that chunk's logs. NOT an RPC cap: the bisecting patch
     * (`lib/rpc-bisecting.ts`) handles per-call provider caps automatically by halving on
     * "range too large" errors (Alchemy free tier = 10 blocks, drpc varies, Infura = 10k). The
     * value here controls how much progress is lost if a tick fails mid-window: 1000 blocks =
     * ~33 min of replay on Sepolia, ~33 min on Base Sepolia, ~4 min on Arbitrum Sepolia.
     */
    maxLogRange: number;
    /**
     * On cold boot WITHOUT a persisted cursor, how far back to start scanning. Recovers
     * messages submitted during the relayer's downtime / before its first boot. Default
     * derived from the chain's block time × ~30 min: Sepolia ~150 blk, Base 900 blk, Anvil 0.
     */
    bootLookbackBlocks: number;
    /**
     * On cold boot WITH a persisted cursor, the maximum gap between the cursor and chain head
     * we'll attempt to backfill. If the cursor is older than this — typically because the
     * relayer was offline for hours — we cap the backfill at `bootLookbackBlocks` and emit a
     * loud warning. Without the cap, a multi-day-old cursor would attempt a multi-day backfill,
     * blowing through RPC quota.
     */
    maxBootLookbackBlocks: number;
    /**
     * Per-RPC-call timeout in ms. Every provider call goes through `withTimeout(...)` so a
     * dead socket / hung connection cannot pin the poll loop.
     */
    rpcTimeoutMs: number;
  };
}

function toChainConfig(net: NetChainConfig, env: string): ChainConfig {
  const suffix = env === "local" ? "" : `-${env}`;
  return {
    rpc: net.rpc,
    chainId: net.chainId,
    name: net.name,
    deploymentFile: `${net.deploymentPrefix}${suffix}-v3.json`,
    privacyPoolDeploymentFile: `privacy-pool-${net.deploymentPrefix}${suffix}.json`,
    cctpDomain: net.cctpDomain,
    scanner: scannerConfigForChain(net.name, env, net.chainId),
  };
}

/**
 * Chain-type classification for scanner defaults, keyed by chainId. The config `name` fields
 * are role labels ("Hub", "Client A", "Client B") that say nothing about the underlying
 * network, so classification MUST NOT match on names. A chainId absent from every set gets
 * the conservative fallback defaults below.
 */
const L1_CHAIN_IDS = new Set([1, 11155111]); // Ethereum mainnet, Ethereum Sepolia
const BASE_LIKE_CHAIN_IDS = new Set([8453, 84532, 10, 11155420]); // Base, Base Sepolia, OP Mainnet, OP Sepolia
const ARB_LIKE_CHAIN_IDS = new Set([42161, 421614]); // Arbitrum One, Arbitrum Sepolia

/**
 * Per-chain scanner defaults. Each value can be overridden by an env var of the form
 * `RELAYER_<KNOB>_<CHAIN>` — e.g. `RELAYER_MAX_LOG_RANGE_HUB=200`. The chain suffix is the
 * chain's config `name` ("Hub", "Client A", "Client B") uppercased with spaces/dashes →
 * underscores: HUB, CLIENT_A, CLIENT_B.
 */
export function scannerConfigForChain(
  chainName: string,
  env: string,
  chainId: number,
): ChainConfig["scanner"] {
  // Anvil has no reorgs and no public-RPC caps — chunking would just slow tests down.
  if (env === "local") {
    return {
      confirmationDepth: envIntForChain("CONFIRMATION_DEPTH", chainName, 0),
      maxLogRange: envIntForChain("MAX_LOG_RANGE", chainName, 10_000),
      bootLookbackBlocks: envIntForChain("BOOT_LOOKBACK_BLOCKS", chainName, 0),
      maxBootLookbackBlocks: envIntForChain("MAX_BOOT_LOOKBACK_BLOCKS", chainName, 100_000),
      rpcTimeoutMs: envIntForChain("RPC_TIMEOUT_MS", chainName, 10_000),
    };
  }

  // Sepolia / testnet defaults. Per-chain block-time tuned bootLookback:
  //   Ethereum Sepolia: ~12s blocks → 150 blocks ≈ 30 min
  //   Base Sepolia:     ~2s blocks  → 900 blocks ≈ 30 min
  //   Arbitrum Sepolia: ~0.25s      → 7200 blocks ≈ 30 min
  const isL1 = L1_CHAIN_IDS.has(chainId);
  const isBaseLike = BASE_LIKE_CHAIN_IDS.has(chainId);
  const isArbLike = ARB_LIKE_CHAIN_IDS.has(chainId);

  const defaultLookback = isL1 ? 150 : isBaseLike ? 900 : isArbLike ? 7_200 : 300;
  const defaultMaxLookback = defaultLookback * 10; // 5 hours of headroom at most
  const defaultConfirmation = isL1 ? 6 : 2;

  return {
    confirmationDepth: envIntForChain("CONFIRMATION_DEPTH", chainName, defaultConfirmation),
    // 1000 blocks is the checkpoint cadence — see RelayerChainConfig.scanner.maxLogRange doc.
    // The bisecting patch handles whatever per-call cap the RPC actually enforces; this value
    // is purely about "how much replay do we accept on a mid-tick failure."
    maxLogRange: envIntForChain("MAX_LOG_RANGE", chainName, 1000),
    bootLookbackBlocks: envIntForChain("BOOT_LOOKBACK_BLOCKS", chainName, defaultLookback),
    maxBootLookbackBlocks: envIntForChain("MAX_BOOT_LOOKBACK_BLOCKS", chainName, defaultMaxLookback),
    rpcTimeoutMs: envIntForChain("RPC_TIMEOUT_MS", chainName, 10_000),
  };
}

function envIntForChain(knob: string, chainName: string, fallback: number): number {
  const suffix = chainName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const key = `RELAYER_${knob}_${suffix}`;
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid env var ${key}=${raw} — expected non-negative integer`);
  }
  return parsed;
}

const netConfig = getNetworkConfig();

// Hub chain configuration
export const hubChain: ChainConfig = toChainConfig(netConfig.hub, netConfig.env);

// Client chains configuration
export const clientChains: ChainConfig[] = [
  toChainConfig(netConfig.clientA, netConfig.env),
  toChainConfig(netConfig.clientB, netConfig.env),
];

// All chains combined
export const allChains: ChainConfig[] = [hubChain, ...clientChains];

// Helper to get chain by ID
export function getChainById(chainId: number): ChainConfig | undefined {
  return allChains.find((c) => c.chainId === chainId);
}

// Helper to check if chain is hub
export function isHubChain(chainId: number): boolean {
  return chainId === hubChain.chainId;
}

// Helper to get deployment file for a chain
export function getDeploymentFile(chainId: number): string | undefined {
  const chain = getChainById(chainId);
  return chain?.deploymentFile;
}

// Accounts - Anvil defaults for local, env-configured for testnet
export const accounts = isLocal()
  ? {
      deployer: {
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      },
      user1: {
        address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      },
      user2: {
        address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      },
    }
  : {
      deployer: {
        address: "", // Derived at runtime from private key
        privateKey: netConfig.deployerPrivateKey,
      },
      user1: {
        address: "",
        privateKey: netConfig.deployerPrivateKey,
      },
      user2: {
        address: "",
        privateKey: netConfig.deployerPrivateKey,
      },
    };

// Relayer settings
export const relayerSettings = {
  pollIntervalMs: isLocal() ? 2000 : netConfig.iris.pollIntervalMs,
};

// CCTP finality mode from unified config
function getCCTPFinalityMode(): "fast" | "standard" {
  return netConfig.cctpFinalityMode;
}

// Armada relayer settings (privacy relay + unified service)
export const armadaRelayerSettings = {
  /** HTTP API port */
  port: netConfig.relayerPort,
  /**
   * Fee markup over gas cost in basis points. POC value is 0 — no margin while testnet
   * iteration is the focus. The relayer takes on gas-price-drift risk within the quote's TTL
   * (a Sepolia gas spike between quote and broadcast eats into operator funds), which is
   * acceptable for team-run testnet infra. Bump to 200-500 for production where margin
   * compression caused by a stale quote should still leave the relayer break-even.
   */
  profitMarginBps: 0,
  /** ETH/USDC price for fee calculation */
  ethUsdcPrice: netConfig.ethUsdcPrice,
  /** Fee quote validity in seconds */
  feeTtlSeconds: 300,
  /** Gas price tolerance (2000 = 20%) */
  feeVarianceBufferBps: 2000,
  /** CCTP poll interval */
  cctpPollIntervalMs: relayerSettings.pollIntervalMs,
  /** Whether CCTP uses real Circle attestation */
  cctpReal: isCCTPReal(),
  /** Iris attestation service config */
  iris: netConfig.iris,
  /** CCTP finality mode: "fast" (~8-20s, 1-1.3 bps fee) or "standard" (~15-19 min, free) */
  cctpFinalityMode: getCCTPFinalityMode(),
  /**
   * Relayer's Railgun `0zk...` address, published verbatim on `/fees` so clients can route the
   * broadcaster-fee output of their SNARK proof here. When empty, the relayer derives it from
   * `RELAYER_RAILGUN_MNEMONIC` at boot; when set, the relayer asserts the derived address
   * matches and fails boot otherwise (cheap misconfiguration detector).
   */
  broadcasterRailgunAddress: process.env.BROADCASTER_RAILGUN_ADDRESS ?? "",
  /**
   * BIP39 mnemonic used to derive the relayer's Railgun (0zk) wallet. Required — relayer
   * refuses to boot without it because broadcaster-fee verification needs the wallet's
   * viewing key to decrypt incoming commitment ciphertexts. Local default lives in
   * `config/local.env` (Anvil's publicly-known test mnemonic); sepolia/prod sourced from
   * gitignored `config/secrets.env`. Loaded at boot only — never logged, never persisted to
   * relayer state (only the engine's leveldown sees derived keys).
   */
  railgunWalletMnemonic: process.env.RELAYER_RAILGUN_MNEMONIC ?? "",
};

// Legacy config export for backward compatibility
export const config = {
  clientChain: clientChains[0],
  hubChain,
  accounts,
  relayer: relayerSettings,
};
