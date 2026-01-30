/**
 * Chain Configuration for Local Devnet
 *
 * Defines chain parameters for our local Anvil instances.
 * These chains are not in the SDK's default network config,
 * so we define them manually.
 *
 * Supports three chains:
 * - Hub Chain (31338) - Where Railgun contracts are deployed
 * - Client Chain A (31337) - User-facing chain for deposits/withdrawals
 * - Client Chain B (31339) - Second client chain for multi-chain testing
 */

import { ChainType, Chain } from "@railgun-community/shared-models";

// ============ Chain Definitions ============

/**
 * Hub Chain - Where Railgun contracts are deployed
 * Anvil instance on port 8546
 */
export const HUB_CHAIN: Chain = {
  type: ChainType.EVM,
  id: 31338,
};

/**
 * Client Chain A - User-facing chain for deposits/withdrawals
 * Anvil instance on port 8545
 */
export const CLIENT_CHAIN: Chain = {
  type: ChainType.EVM,
  id: 31337,
};

/**
 * Client Chain B - Second client chain for multi-chain testing
 * Anvil instance on port 8547
 */
export const CLIENT_CHAIN_B: Chain = {
  type: ChainType.EVM,
  id: 31339,
};

// ============ RPC Configuration ============

export const HUB_RPC = "http://localhost:8546";
export const CLIENT_RPC = "http://localhost:8545";
export const CLIENT_B_RPC = "http://localhost:8547";

// ============ All Chains ============

/**
 * Array of all supported chains
 */
export const ALL_CHAINS: Chain[] = [HUB_CHAIN, CLIENT_CHAIN, CLIENT_CHAIN_B];

/**
 * Array of all client chains (non-hub)
 */
export const CLIENT_CHAINS: Chain[] = [CLIENT_CHAIN, CLIENT_CHAIN_B];

// ============ Deployment Configuration ============

/**
 * Deployment block for local devnet (always 0)
 */
export const DEPLOYMENT_BLOCK = 0;

/**
 * Whether the chain supports V3 contracts (Poseidon merkle tree)
 * Our POC uses V2-style contracts
 */
export const SUPPORTS_V3 = false;

// ============ Network Name ============

/**
 * Custom network name for our local devnet
 * Used for SDK network lookups
 */
export const HUB_NETWORK_NAME = "LocalDevnetHub";
export const CLIENT_NETWORK_NAME = "LocalDevnetClient";
export const CLIENT_B_NETWORK_NAME = "LocalDevnetClientB";

// ============ Helper Functions ============

/**
 * Get chain by ID
 */
export function getChainById(chainId: number): Chain | undefined {
  if (chainId === HUB_CHAIN.id) return HUB_CHAIN;
  if (chainId === CLIENT_CHAIN.id) return CLIENT_CHAIN;
  if (chainId === CLIENT_CHAIN_B.id) return CLIENT_CHAIN_B;
  return undefined;
}

/**
 * Get RPC URL for chain
 */
export function getRpcUrl(chain: Chain): string {
  if (chain.id === HUB_CHAIN.id) return HUB_RPC;
  if (chain.id === CLIENT_CHAIN.id) return CLIENT_RPC;
  if (chain.id === CLIENT_CHAIN_B.id) return CLIENT_B_RPC;
  throw new Error(`Unknown chain ID: ${chain.id}`);
}

/**
 * Check if chain is our hub chain
 */
export function isHubChain(chain: Chain): boolean {
  return chain.id === HUB_CHAIN.id && chain.type === ChainType.EVM;
}

/**
 * Check if chain is a client chain (A or B)
 */
export function isClientChain(chain: Chain): boolean {
  return (
    (chain.id === CLIENT_CHAIN.id || chain.id === CLIENT_CHAIN_B.id) &&
    chain.type === ChainType.EVM
  );
}

/**
 * Get network name for chain
 */
export function getNetworkName(chain: Chain): string {
  if (chain.id === HUB_CHAIN.id) return HUB_NETWORK_NAME;
  if (chain.id === CLIENT_CHAIN.id) return CLIENT_NETWORK_NAME;
  if (chain.id === CLIENT_CHAIN_B.id) return CLIENT_B_NETWORK_NAME;
  throw new Error(`Unknown chain ID: ${chain.id}`);
}

/**
 * Get deployment file name for chain
 */
export function getDeploymentFileName(chain: Chain): string {
  if (chain.id === HUB_CHAIN.id) return "hub.json";
  if (chain.id === CLIENT_CHAIN.id) return "client.json";
  if (chain.id === CLIENT_CHAIN_B.id) return "clientB.json";
  throw new Error(`Unknown chain ID: ${chain.id}`);
}
