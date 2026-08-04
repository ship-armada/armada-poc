// ABOUTME: Multicall3 aggregate3 helper — batches many contract reads into a single eth_call.
// ABOUTME: Duplicated from @armada/crowdfund-shared/lib/multicall3.ts; extract to @armada/eth-utils when both apps evolve it.

import { Contract, Interface, type JsonRpcProvider, type Result } from 'ethers'

/** Canonical Multicall3 deployment address (same on every chain it's deployed to). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]

const multicall3Interface = new Interface(MULTICALL3_ABI)

/** A Multicall3 contract bound to `provider` — used to fold `getCurrentBlockTimestamp()` into a batch. */
export function getMulticall3Contract(provider: JsonRpcProvider): Contract {
  return new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider)
}

export interface AggregateCall {
  /** Contract whose interface encodes the call and decodes the return data. */
  contract: Contract
  /** Function name on that contract's interface. */
  functionName: string
  /** Function arguments (default none). */
  args?: readonly unknown[]
}

export interface AggregateResult {
  /** False when the sub-call reverted or returned no data — the caller should carry forward. */
  success: boolean
  /** Decoded result tuple when `success`; undefined otherwise. */
  result: Result | undefined
}

/**
 * Batch `calls` into a single `aggregate3` eth_call (with `allowFailure: true`)
 * and return per-call decoded results. A reverting sub-call comes back as
 * `{ success: false, result: undefined }` rather than throwing the whole batch;
 * a provider/RPC failure rejects (mirroring a failed read burst).
 */
export async function aggregate3(
  provider: JsonRpcProvider,
  calls: readonly AggregateCall[],
): Promise<AggregateResult[]> {
  const structs = calls.map((c) => ({
    target: String(c.contract.target),
    allowFailure: true,
    callData: c.contract.interface.encodeFunctionData(c.functionName, c.args ?? []),
  }))

  const data = multicall3Interface.encodeFunctionData('aggregate3', [structs])
  const raw = await provider.call({ to: MULTICALL3_ADDRESS, data })
  const [rows] = multicall3Interface.decodeFunctionResult('aggregate3', raw) as unknown as [
    Array<{ success: boolean; returnData: string }>,
  ]

  return calls.map((c, i) => {
    const row = rows[i]
    if (!row?.success || row.returnData === '0x') {
      return { success: false, result: undefined }
    }
    try {
      return { success: true, result: c.contract.interface.decodeFunctionResult(c.functionName, row.returnData) }
    } catch {
      // Decode mismatch (shouldn't happen, but never let one bad return poison the batch).
      return { success: false, result: undefined }
    }
  })
}
