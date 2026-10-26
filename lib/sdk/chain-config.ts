/**
 * Chain Configuration for Local Devnet
 *
 * Defines chain parameters for our local Anvil instances.
 * These chains are not in the SDK's default network config,
 * so we define them manually.
 *
 * Supports three chains:
 * - Hub Chain (31338) - Where the privacy pool is deployed
 * - Client Chain A (31337) - User-facing chain for deposits/withdrawals
 * - Client Chain B (31339) - Second client chain for multi-chain testing
 */

import { ChainType, Chain } from "@railgun-community/shared-models";

// ============ Chain Definitions ============

/**
 * Hub Chain - Where the privacy pool is deployed
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
