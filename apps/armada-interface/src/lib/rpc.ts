// ABOUTME: RPC provider creation with ordered fallback across multiple URLs.
// ABOUTME: Duplicated from @armada/crowdfund-shared/lib/rpc.ts (with crowdfund-specific log fetching trimmed). Extract to @armada/eth-utils when both apps evolve it.

import { FetchRequest, JsonRpcProvider } from 'ethers'
import type { JsonRpcPayload, JsonRpcResult } from 'ethers'

/** ethers' default FetchRequest timeout is ~300s, which defeats fallback — a black-holed URL
 *  hangs for 5 min before the next is tried. Bound every internal provider at 15s. (P1-18) */
const RPC_FETCH_TIMEOUT_MS = 15_000

function timeoutRequest(url: string): FetchRequest {
  const req = new FetchRequest(url)
  req.timeout = RPC_FETCH_TIMEOUT_MS
  return req
}

/**
 * JsonRpcProvider subclass that tries multiple RPC URLs in order.
 * On transport-level errors (connection refused, timeout, HTTP 5xx),
 * automatically retries with the next URL. RPC-level errors (execution
 * reverted, invalid params) are NOT retried.
 *
 * On success, "sticks" to that URL for subsequent calls until it fails.
 *
 * Note: overrides ethers v6 internal `_send()`. If ethers changes its
 * transport API, this class needs updating.
 */
export class FallbackJsonRpcProvider extends JsonRpcProvider {
  /** @internal exposed for testing — internal providers, one per URL */
  readonly _providers: JsonRpcProvider[]
  private _currentIndex = 0

  constructor(urls: readonly string[]) {
    if (urls.length === 0) throw new Error('FallbackJsonRpcProvider: at least one URL required')
    const first = urls[0]
    if (!first) throw new Error('FallbackJsonRpcProvider: first URL is empty')
    super(timeoutRequest(first))
    this._providers = urls.map(u => new JsonRpcProvider(timeoutRequest(u)))
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    let lastError: unknown
    for (let attempt = 0; attempt < this._providers.length; attempt++) {
      const index = (this._currentIndex + attempt) % this._providers.length
      const provider = this._providers[index]
      if (!provider) continue
      try {
        const result = await provider._send(payload)
        this._currentIndex = index
        return result
      } catch (err) {
        lastError = err
        // Only fall through to the next URL for transport-level failures.
        // RPC-level errors (execution reverted, invalid params, etc.) are
        // deterministic — retrying against another node either masks them with
        // stale state or duplicates work. Surface them to the caller.
        if (!isTransportError(err)) throw err
      }
    }
    throw lastError
  }
}

/**
 * Classify whether an ethers/fetch error is transport-level (network, timeout,
 * 5xx, connection refused) vs. RPC-level (execution reverted, invalid argument,
 * bad data). Defaults to NOT retrying on unknown errors — better to surface a
 * real problem than silently mask it by hopping providers.
 */
function isTransportError(err: unknown): boolean {
  if (err === null || err === undefined) return true
  const e = err as { code?: string; message?: string }
  const code = e.code
  if (code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'SERVER_ERROR') return true
  // ethers v6 emits these for non-transport problems; do NOT retry.
  if (code === 'CALL_EXCEPTION' || code === 'INVALID_ARGUMENT' || code === 'BAD_DATA'
    || code === 'NUMERIC_FAULT' || code === 'UNSUPPORTED_OPERATION'
    || code === 'INSUFFICIENT_FUNDS' || code === 'NONCE_EXPIRED'
    || code === 'REPLACEMENT_UNDERPRICED' || code === 'TRANSACTION_REPLACED'
    || code === 'ACTION_REJECTED') return false
  const msg = e.message ?? ''
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|aborted/i.test(msg)) return true
  return false
}

/** Create a provider with optional ordered fallback. Single URL → plain `JsonRpcProvider`. */
export function createProvider(urls: readonly string[]): JsonRpcProvider {
  if (urls.length === 0) throw new Error('createProvider: no RPC URLs provided')
  const first = urls[0]
  if (!first) throw new Error('createProvider: first URL is empty')
  if (urls.length === 1) return new JsonRpcProvider(timeoutRequest(first))
  return new FallbackJsonRpcProvider(urls)
}
