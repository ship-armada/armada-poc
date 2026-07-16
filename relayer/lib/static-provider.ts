// ABOUTME: Constructs ethers JsonRpcProviders pinned to a known chainId (staticNetwork) so
// ABOUTME: ethers skips per-request eth_chainId re-verification — a material share of RPC quota.

import { ethers } from "ethers";

/**
 * Create a JsonRpcProvider pinned to `chainId`. Without a static network, ethers v6 re-verifies
 * the endpoint's chainId alongside request batches; on a long-running poller that overhead is a
 * significant fraction of total RPC request volume on quota-billed endpoints.
 *
 * Pinning is safe here because the relayer's chain set is fixed at boot from config — the
 * network can never legitimately change mid-process. If an RPC endpoint were misconfigured to
 * serve a different chain, transactions would fail loudly on chainId mismatch at signing rather
 * than being silently sent to the wrong network.
 *
 * All relayer providers should be constructed through this helper.
 */
export function createStaticProvider(rpc: string, chainId: number): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
}
