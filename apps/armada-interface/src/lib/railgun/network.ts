// ABOUTME: Hub-chain RPC helpers — a one-shot timeout-bounded JsonRpcProvider plus current-block and
// ABOUTME: block-timestamp lookups. Pure ethers; no @armada/sdk or shielded-engine coupling.

import { ethers } from 'ethers'
import { getNetworkConfig } from '@/config/network'

/** One-shot RPC timeout. ethers' default FetchRequest timeout is ~300s, which defeats failover —
 *  a black-holed endpoint would hang for 5 min. Cap at 15s so callers fail (or fall back) fast. */
const ONE_SHOT_RPC_TIMEOUT_MS = 15_000

/**
 * Build a one-shot JsonRpcProvider with an explicit fetch timeout (P1-18). Plain
 * `new JsonRpcProvider(url)` inherits ethers' ~300s default, so a wedged RPC pins the caller far
 * past any reasonable budget. Constructing from a `FetchRequest` lets us bound it.
 *
 * `batchMaxCount` caps how many concurrent JSON-RPC calls ethers folds into a single batch request.
 * ethers batches by default (~100), but some free-tier RPCs reject large batches (e.g. drpc's free
 * plan rejects batches >3). Pass `1` to disable batching entirely — one HTTP request per call — for
 * callers that fan out many concurrent reads against a possibly batch-limited endpoint. Omit to keep
 * ethers' default batching.
 */
export function timeoutProvider(
  url: string,
  timeoutMs: number = ONE_SHOT_RPC_TIMEOUT_MS,
  batchMaxCount?: number,
): ethers.JsonRpcProvider {
  const req = new ethers.FetchRequest(url)
  req.timeout = timeoutMs
  return new ethers.JsonRpcProvider(
    req,
    undefined,
    batchMaxCount !== undefined ? { batchMaxCount } : undefined,
  )
}

/**
 * Fetch the current block number on the hub chain. Used at wallet enroll to seed the
 * @armada/sdk wallet's creation block — tells the scan "this wallet didn't exist before block N,
 * skip decryption attempts on commitments older than that."
 *
 * Spins up a one-shot JsonRpcProvider. Cheap; not worth caching since the result changes.
 */
export async function getCurrentHubBlock(): Promise<number | null> {
  const hubChain = getNetworkConfig().hub
  const primaryRpc = hubChain.rpcUrls[0]
  if (!primaryRpc) return null
  try {
    const provider = timeoutProvider(primaryRpc)
    return await provider.getBlockNumber()
  } catch {
    // Non-fatal — wallet enroll proceeds without a creation block, the scan just does slightly
    // more decryption work on the first pass. No correctness impact.
    return null
  }
}

/**
 * Look up the chain timestamp (seconds since epoch) for one or more hub-chain block numbers.
 * Used by `runHistoryScan` to backfill timestamps on SDK history items where the SDK didn't
 * populate `item.timestamp` itself (observed on local Anvil chains and some RPC providers).
 *
 * Deduplicates input block numbers — N items sharing one block produce one RPC call. Results
 * are returned as a `Map<blockNumber, timestampSeconds>`; missing entries mean the lookup
 * failed and the caller should keep its existing (possibly zero) timestamp.
 */
export async function getHubBlockTimestamps(
  blockNumbers: ReadonlyArray<number>,
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  if (blockNumbers.length === 0) return result
  const hubChain = getNetworkConfig().hub
  const primaryRpc = hubChain.rpcUrls[0]
  if (!primaryRpc) return result
  // Dedup before issuing RPC calls — first-scan recovery on a busy wallet can hit dozens of
  // items spread across a few blocks, and `eth_getBlockByNumber` is one of the more expensive
  // public-RPC reads.
  const unique = Array.from(new Set(blockNumbers))
  const provider = timeoutProvider(primaryRpc)
  const blocks = await Promise.allSettled(
    unique.map((bn) => provider.getBlock(bn)),
  )
  for (let i = 0; i < unique.length; i++) {
    const settled = blocks[i]
    const blockNumber = unique[i]
    if (settled?.status === 'fulfilled' && settled.value && blockNumber !== undefined) {
      result.set(blockNumber, settled.value.timestamp)
    }
  }
  return result
}
