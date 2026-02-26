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
  };
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

// CCTP finality mode from environment
function getCCTPFinalityMode(): "fast" | "standard" {
  const mode = process.env.CCTP_FINALITY_MODE?.toLowerCase();
  return mode === "fast" ? "fast" : "standard";
}

// Armada relayer settings (privacy relay + unified service)
export const armadaRelayerSettings = {
  /** HTTP API port */
  port: netConfig.relayerPort,
  /** Fee markup over gas cost (1000 = 10%) */
  profitMarginBps: 1000,
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
};

// Legacy config export for backward compatibility
export const config = {
  clientChain: clientChains[0],
  hubChain,
  accounts,
  relayer: relayerSettings,
};
