// ABOUTME: One-time monkey-patch of ethers' JsonRpcProvider.send that bisects eth_getLogs on "block range too large" errors.
// ABOUTME: Free-tier RPCs (Alchemy 10 blocks, Infura 10k, drpc varies) all reject large ranges with subtly different error messages — bisection lets the SDK keep its preferred chunk size without us needing to choose an RPC by its limit.

import { JsonRpcProvider } from 'ethers'

/**
 * Substrings / regexes that identify "block range too large" errors from common RPC providers.
 * Different providers word it differently:
 *
 *   - Alchemy:    "you can make eth_getLogs requests with up to a 10 block range"
 *   - Infura:     "query returned more than 10000 results"
 *   - QuickNode:  "eth_getLogs is limited to a X block range"
 *   - Cloudflare: "block range is too wide"
 *   - drpc:       varies, sometimes "too many records"
 *
 * If we see a NEW provider whose phrasing slips through, we'll get a non-range error treatment
 * (propagated to the caller) until the pattern is added here.
 */
const RANGE_ERROR_PATTERNS: readonly RegExp[] = [
  /block range/i,
  /more than [\d,]+ (results|records|logs)/i,
  /range is too wide/i,
  /response size exceeded/i,
  /eth_getLogs.*limit/i,
  // Deliberately omitted: /query timeout/i. A generic timeout could be a transient network
  // issue rather than a range-too-large signal; bisecting on it doubles load and is very
  // likely to time out again. Providers that DO time out specifically on large getLogs ranges
  // (rather than returning an explicit error) will fall through to the caller — we'll handle
  // those by adding a more specific pattern (e.g. requiring co-occurrence with getLogs
  // context) once we see one in practice.
] as const

function isBlockRangeError(err: unknown): boolean {
  if (err == null) return false
  // ethers wraps server errors with { code, info, error: { message } } shapes; dig through.
  const candidates: string[] = []
  const e = err as Record<string, unknown>
  if (typeof e.message === 'string') candidates.push(e.message)
  if (typeof e.error === 'object' && e.error !== null) {
    const inner = e.error as { message?: unknown }
    if (typeof inner.message === 'string') candidates.push(inner.message)
  }
  if (typeof e.info === 'object' && e.info !== null) {
    const info = e.info as { responseBody?: unknown; error?: { message?: unknown } }
    if (typeof info.responseBody === 'string') candidates.push(info.responseBody)
    if (typeof info.error?.message === 'string') candidates.push(info.error.message)
  }
  return candidates.some(s => RANGE_ERROR_PATTERNS.some(p => p.test(s)))
}

interface GetLogsFilter {
  fromBlock?: string
  toBlock?: string
  address?: string | readonly string[]
  topics?: readonly (string | readonly string[] | null)[]
}

function parseHexBlock(v: string | undefined): number | null {
  if (typeof v !== 'string' || !v.startsWith('0x')) return null
  const n = parseInt(v.slice(2), 16)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function toHexBlock(n: number): string {
  return '0x' + n.toString(16)
}

/** Cap on recursive bisection depth. 2^25 = 33M blocks; safety net against pathological inputs. */
const MAX_BISECT_DEPTH = 25

/**
 * Run a single eth_getLogs call; on a "range too large" error, recursively split the range and
 * merge the results. Bails out (re-throws) on non-range errors and when the range is already a
 * single block (can't split further). The `send` parameter is the raw original ethers provider
 * send method bound to the provider instance — passing it in keeps this function pure.
 */
async function bisectEthGetLogs(
  send: (method: string, params: unknown[]) => Promise<unknown>,
  filter: GetLogsFilter,
  depth: number,
): Promise<unknown[]> {
  try {
    const result = await send('eth_getLogs', [filter])
    return Array.isArray(result) ? result : []
  } catch (err) {
    if (!isBlockRangeError(err)) throw err
    const from = parseHexBlock(filter.fromBlock)
    const to = parseHexBlock(filter.toBlock)
    if (from == null || to == null || to <= from) throw err // can't split
    if (depth >= MAX_BISECT_DEPTH) {
      // Wrap the original RPC error with bisection context so debug output points at the
      // pathological range without losing the upstream message.
      const original = err instanceof Error ? err.message : String(err)
      throw new Error(
        `eth_getLogs bisection exceeded max depth ${MAX_BISECT_DEPTH} at range ${from}..${to}: ${original}`,
        { cause: err instanceof Error ? err : undefined },
      )
    }
    const mid = Math.floor((from + to) / 2)
    if (mid <= from || mid >= to) throw err // single-block range
    // Recurse on left + right halves; concatenate results. Order matters for some downstream
    // consumers (the engine processes events in chronological order).
    const leftFilter: GetLogsFilter = { ...filter, fromBlock: toHexBlock(from), toBlock: toHexBlock(mid) }
    const rightFilter: GetLogsFilter = { ...filter, fromBlock: toHexBlock(mid + 1), toBlock: toHexBlock(to) }
    const left = await bisectEthGetLogs(send, leftFilter, depth + 1)
    const right = await bisectEthGetLogs(send, rightFilter, depth + 1)
    return [...left, ...right]
  }
}

const PATCHED_FLAG = Symbol.for('armada.bisectingGetLogs.patched')
type PatchedPrototype = typeof JsonRpcProvider.prototype & { [PATCHED_FLAG]?: boolean }

/**
 * Patches `JsonRpcProvider.prototype.send` to intercept eth_getLogs calls and bisect on range
 * errors. Idempotent — safe to call multiple times. Non-getLogs RPC calls pass through unchanged.
 *
 * Affects every ethers JsonRpcProvider in the process — including the SDK's
 * PollingJsonRpcProvider (which extends JsonRpcProvider). Wagmi/viem providers are unaffected
 * (different stack).
 *
 * Call this once at app entry (main.tsx) before any provider is constructed. Calling after a
 * provider exists is also fine — the patch is at the prototype level, so existing instances
 * pick it up too.
 */
export function installBisectingGetLogs(): void {
  const proto = JsonRpcProvider.prototype as PatchedPrototype
  if (proto[PATCHED_FLAG]) return
  proto[PATCHED_FLAG] = true

  const originalSend = proto.send
  proto.send = async function patchedSend(this: JsonRpcProvider, method: string, params: unknown[]) {
    if (method !== 'eth_getLogs' || !Array.isArray(params) || params.length === 0) {
      return originalSend.call(this, method, params)
    }
    const filter = params[0]
    if (filter == null || typeof filter !== 'object') {
      return originalSend.call(this, method, params)
    }
    const boundSend = (m: string, p: unknown[]): Promise<unknown> => originalSend.call(this, m, p)
    return bisectEthGetLogs(boundSend, filter as GetLogsFilter, 0)
  }
}

/** Test-only: verify whether the patch is currently installed. */
export function _isBisectingGetLogsPatched(): boolean {
  return Boolean((JsonRpcProvider.prototype as PatchedPrototype)[PATCHED_FLAG])
}

/** Test-only: unmount the patch so subsequent tests see a clean prototype. */
export function _uninstallBisectingGetLogs(): void {
  const proto = JsonRpcProvider.prototype as PatchedPrototype
  if (!proto[PATCHED_FLAG]) return
  delete proto[PATCHED_FLAG]
  // Restore the original send by deleting the patched one — the class's original lives on the
  // class prototype chain. We replaced the own property, so delete restores the inherited one.
  delete (proto as { send?: unknown }).send
}

// Internal exports for tests. Don't import these from app code.
export { bisectEthGetLogs as _bisectEthGetLogs, isBlockRangeError as _isBlockRangeError }
