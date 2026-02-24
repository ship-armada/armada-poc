import "dotenv/config";

/**
 * POC Configuration
 *
 * Multi-chain configuration for the CCTP demo
 * Supports N client chains connecting to a single hub
 */

export interface ChainConfig {
  rpc: string;
  chainId: number;
  name: string;
  deploymentFile: string;  // Name of the deployment JSON file
}

// Hub chain configuration (single hub)
// Uses chain ID 31337 and port 8545 to match Railgun SDK's Hardhat network config
export const hubChain: ChainConfig = {
  rpc: "http://localhost:8545",
  chainId: 31337,
  name: "Hub",
  deploymentFile: "hub-v3.json",
};

// Client chains configuration (array for N chains)
export const clientChains: ChainConfig[] = [
  {
    rpc: "http://localhost:8546",
    chainId: 31338,
    name: "Client A",
    deploymentFile: "client-v3.json",
  },
  {
    rpc: "http://localhost:8547",
    chainId: 31339,
    name: "Client B",
    deploymentFile: "clientB-v3.json",
  },
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

// Anvil default funded accounts
// Private keys are loaded from environment variables (see .env.example)
export const accounts = {
  // Deployer / Relayer (Account 0)
  deployer: {
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    privateKey: process.env.DEPLOYER_PRIVATE_KEY!,
  },
  // Test User 1 (Account 1)
  user1: {
    address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    privateKey: process.env.USER1_PRIVATE_KEY!,
  },
  // Test User 2 (Account 2)
  user2: {
    address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    privateKey: process.env.USER2_PRIVATE_KEY!,
  },
};

// Relayer settings
export const relayerSettings = {
  pollIntervalMs: 2000, // How often to check for new burns
};

// Armada relayer settings (privacy relay + unified service)
export const armadaRelayerSettings = {
  /** HTTP API port */
  port: 3001,
  /** Fee markup over gas cost (1000 = 10%) */
  profitMarginBps: 1000,
  /** Hardcoded ETH/USDC price for local dev */
  ethUsdcPrice: 2000,
  /** Fee quote validity in seconds */
  feeTtlSeconds: 300,
  /** Gas price tolerance (2000 = 20%) */
  feeVarianceBufferBps: 2000,
  /** CCTP poll interval */
  cctpPollIntervalMs: relayerSettings.pollIntervalMs,
};

// Legacy config export for backward compatibility
export const config = {
  clientChain: clientChains[0],  // Client A for backward compat
  hubChain,
  accounts,
  relayer: relayerSettings,
};
