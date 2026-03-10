// ABOUTME: Creates and caches ethers JsonRpcProviders for each chain role.
// ABOUTME: Providers are lazily created and reused across tool calls.

import { ethers } from "ethers";
import {
  type ChainRole,
  getChainByRole,
} from "../../../config/networks";

const RPC_TIMEOUT_MS = 5000;

const providerCache = new Map<ChainRole, ethers.JsonRpcProvider>();

/**
 * Get or create a provider for a chain role.
 * Providers are cached for the lifetime of the server process.
 */
export function getProvider(role: ChainRole): ethers.JsonRpcProvider {
  let provider = providerCache.get(role);
  if (provider) return provider;

  const chain = getChainByRole(role);
  provider = new ethers.JsonRpcProvider(chain.rpc, undefined, {
    staticNetwork: true,
  });
  providerCache.set(role, provider);
  return provider;
}

/**
 * Check if a provider can reach its RPC endpoint.
 * Returns block number on success, null on failure.
 */
export async function checkRpc(
  role: ChainRole
): Promise<{ blockNumber: number; chainId: number } | null> {
  const provider = getProvider(role);
  try {
    const [blockNumber, network] = await Promise.all([
      withTimeout(provider.getBlockNumber(), RPC_TIMEOUT_MS),
      withTimeout(provider.getNetwork(), RPC_TIMEOUT_MS),
    ]);
    return { blockNumber, chainId: Number(network.chainId) };
  } catch {
    return null;
  }
}

/**
 * Get ETH balance for an address on a chain.
 */
export async function getBalance(
  role: ChainRole,
  address: string
): Promise<string | null> {
  try {
    const provider = getProvider(role);
    const balance = await withTimeout(
      provider.getBalance(address),
      RPC_TIMEOUT_MS
    );
    return ethers.formatEther(balance);
  } catch {
    return null;
  }
}

/**
 * Check if there is contract code at an address.
 */
export async function hasCode(
  role: ChainRole,
  address: string
): Promise<boolean | null> {
  try {
    const provider = getProvider(role);
    const code = await withTimeout(
      provider.getCode(address),
      RPC_TIMEOUT_MS
    );
    return code !== "0x";
  } catch {
    return null;
  }
}

/**
 * Call a view function on a contract.
 */
export async function callView(
  role: ChainRole,
  address: string,
  abi: string[],
  functionName: string,
  args: unknown[] = []
): Promise<unknown> {
  const provider = getProvider(role);
  const contract = new ethers.Contract(address, abi, provider);
  return withTimeout(contract[functionName](...args), RPC_TIMEOUT_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout (${ms}ms)`)), ms)
    ),
  ]);
}
