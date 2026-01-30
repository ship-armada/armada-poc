/**
 * Tendermint RPC Client
 * 
 * Provides interface for making Tendermint RPC calls (tx_search, getBlockResults, etc.)
 * Used by Noble and Namada pollers.
 */

import { logger } from '@/utils/logger'
import { retryWithBackoff } from './basePoller'

/**
 * Tendermint transaction structure
 */
export interface TendermintTx {
  hash: string
  height: string
  tx_result?: {
    events?: Array<{
      type: string
      attributes?: Array<{ key: string; value: string; index?: boolean }>
    }>
  }
  result?: {
    events?: Array<{
      type: string
      attributes?: Array<{ key: string; value: string; index?: boolean }>
    }>
  }
}

/**
 * Tendermint block results structure
 */
export interface TendermintBlockResults {
  height: string
  finalize_block_events?: Array<{
    type: string
    attributes?: Array<{ key: string; value: string; index?: boolean }>
  }>
  end_block_events?: Array<{
    type: string
    attributes?: Array<{ key: string; value: string; index?: boolean }>
  }>
}

/**
 * Tendermint block structure (from getBlock RPC call)
 */
export interface TendermintBlock {
  block?: {
    header?: {
      height?: string
      time?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  header?: {
    height?: string
    time?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Tendermint broadcast transaction response
 */
export interface TendermintBroadcastTxResponse {
  code?: number
  data?: string
  log?: string
  codespace?: string
  hash: string
}

/**
 * Tendermint RPC Client interface
 */
export interface TendermintRpcClient {
  /**
   * Search for transactions by query
   * 
   * @param query - Search query (e.g., "circle.cctp.v1.MessageReceived.nonce='\"123\"'")
   * @param page - Page number (default: 1)
   * @param perPage - Results per page (default: 30)
   * @param abortSignal - Optional abort signal
   * @returns Array of matching transactions
   */
  searchTransactions(
    query: string,
    page?: number,
    perPage?: number,
    abortSignal?: AbortSignal,
  ): Promise<TendermintTx[]>

  /**
   * Get block results for a specific height
   * 
   * @param height - Block height
   * @param abortSignal - Optional abort signal
   * @returns Block results or null if not found
   */
  getBlockResults(height: number, abortSignal?: AbortSignal): Promise<TendermintBlockResults | null>

  /**
   * Get block for a specific height (includes timestamp)
   * 
   * Note: getBlockResults only contains height, not timestamp.
   * Use this method to get the full block including timestamp.
   * 
   * @param height - Block height
   * @param abortSignal - Optional abort signal
   * @returns Block or null if not found
   */
  getBlock(height: number, abortSignal?: AbortSignal): Promise<TendermintBlock | null>

  /**
   * Get latest block height
   * 
   * @param abortSignal - Optional abort signal
   * @returns Latest block height
   */
  getLatestBlockHeight(abortSignal?: AbortSignal): Promise<number>

  /**
   * Broadcast a transaction synchronously
   * Returns with CheckTx response, does not wait for commit
   * 
   * @param txBytes - Base64-encoded transaction bytes
   * @param abortSignal - Optional abort signal
   * @returns Broadcast response with hash and CheckTx result
   */
  broadcastTxSync(
    txBytes: string,
    abortSignal?: AbortSignal,
  ): Promise<TendermintBroadcastTxResponse>
}

/**
 * Create Tendermint RPC client
 * 
 * @param rpcUrl - RPC endpoint URL
 * @returns Tendermint RPC client instance
 */
export function createTendermintRpcClient(rpcUrl: string): TendermintRpcClient {
  /**
   * Make JSON-RPC request
   */
  async function callRpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }

    // Check abort signal before making request
    if (abortSignal?.aborted) {
      throw new Error('Polling cancelled')
    }

    // Log the payload for debugging (but truncate large values like tx bytes)
    const logParams = { ...params }
    if (logParams.tx && typeof logParams.tx === 'string') {
      logParams.tx = (logParams.tx as string).substring(0, 20) + '...' + ` (${(logParams.tx as string).length} chars)`
    }
    logger.debug('[TendermintRpcClient] JSON-RPC call', {
      method,
      params: logParams,
    })

    let response: Response
    try {
      response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: abortSignal,
      })
    } catch (fetchError) {
      // Handle AbortError from fetch
      if (fetchError instanceof Error && (fetchError.name === 'AbortError' || abortSignal?.aborted)) {
        throw new Error('Polling cancelled')
      }
      throw fetchError
    }

    // Check abort signal after fetch (in case it was aborted during the request)
    if (abortSignal?.aborted) {
      throw new Error('Polling cancelled')
    }

    if (!response.ok) {
      throw new Error(`Tendermint RPC error: ${response.status} ${response.statusText}`)
    }

    let data: any
    try {
      data = await response.json()
    } catch (parseError) {
      // If abort happened during JSON parsing, check signal
      if (abortSignal?.aborted) {
        throw new Error('Polling cancelled')
      }
      throw parseError
    }

    // Check abort signal after parsing response
    if (abortSignal?.aborted) {
      throw new Error('Polling cancelled')
    }

    if (data.error) {
      throw new Error(
        `Tendermint RPC error (${data.error.code}): ${data.error.message}`,
      )
    }

    return data.result as T
  }

  return {
    async searchTransactions(
      query: string,
      page: number = 1,
      perPage: number = 30,
      abortSignal?: AbortSignal,
    ): Promise<TendermintTx[]> {
      // Format query: wrap entire query string in double quotes (matching backend exactly)
      // Example input query: circle.cctp.v1.MessageReceived.nonce='\"704111\"'
      // Example formatted: "circle.cctp.v1.MessageReceived.nonce='\"704111\"'"
      const formattedQuery = `"${query}"`
      
      // Manually construct the URL-encoded query parameter (matching backend exactly)
      // Format: "circle.cctp.v1.MessageReceived.nonce%3D%27\"704111\"%27"
      // - Outer quotes are literal (encoded for HTTP)
      // - = is encoded as %3D
      // - ' is encoded as %27
      // - \" stays as \" (backslash + quote, not encoded)
      // Strategy: encode everything, then replace encoded backslashes with literal backslashes
      let queryParam = encodeURIComponent(formattedQuery)
      // Replace %5C (encoded backslash) with literal backslash
      queryParam = queryParam.replace(/%5C/g, '\\')
      
      // Build URL with query parameter only (page/per_page/order_by removed as they cause query to fail)
      const url = `/tx_search?query=${queryParam}`
      
      // Construct full URL
      const baseURL = rpcUrl.endsWith('/') ? rpcUrl.slice(0, -1) : rpcUrl
      const fullUrl = `${baseURL}${url}`
      
      logger.debug('[TendermintRpcClient] tx_search request (GET)', {
        rawQuery: query,
        formattedQuery,
        queryParam,
        fullUrl,
        page,
        perPage,
      })

      try {
        // Check abort signal before making request
        if (abortSignal?.aborted) {
          throw new Error('Polling cancelled')
        }

        let response: Response
        try {
          response = await fetch(fullUrl, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
            signal: abortSignal,
          })
        } catch (fetchError) {
          // Handle AbortError from fetch
          if (fetchError instanceof Error && (fetchError.name === 'AbortError' || abortSignal?.aborted)) {
            throw new Error('Polling cancelled')
          }
          throw fetchError
        }

        // Check abort signal after fetch
        if (abortSignal?.aborted) {
          throw new Error('Polling cancelled')
        }

        if (!response.ok) {
          throw new Error(`Tendermint RPC error: ${response.status} ${response.statusText}`)
        }

        let data: any
        try {
          data = await response.json()
        } catch (parseError) {
          if (abortSignal?.aborted) {
            throw new Error('Polling cancelled')
          }
          throw parseError
        }

        // Check abort signal after parsing response
        if (abortSignal?.aborted) {
          throw new Error('Polling cancelled')
        }

        if (data.error) {
          throw new Error(
            `Tendermint RPC error (${data.error.code}): ${data.error.message}`,
          )
        }

        // Handle different response structures (matching backend)
        const txs = data?.txs || data?.result?.txs || []
        
        logger.debug('[TendermintRpcClient] tx_search result', {
          query,
          txCount: txs.length,
          totalCount: data?.total_count || data?.result?.total_count,
        })
        
        return txs
      } catch (error) {
        logger.warn('[TendermintRpcClient] tx_search failed', {
          query,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },

    async getBlockResults(height: number, abortSignal?: AbortSignal): Promise<TendermintBlockResults | null> {
      try {
        const result = await retryWithBackoff(
          () => callRpc<TendermintBlockResults>('block_results', { height: height.toString() }, abortSignal),
          3,
          500,
          5000,
          abortSignal,
        )
        return result
      } catch (error) {
        logger.warn('[TendermintRpcClient] getBlockResults failed', {
          height,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },

    async getBlock(height: number, abortSignal?: AbortSignal): Promise<TendermintBlock | null> {
      try {
        const result = await retryWithBackoff(
          () => callRpc<TendermintBlock>('block', { height: height.toString() }, abortSignal),
          3,
          500,
          5000,
          abortSignal,
        )
        return result
      } catch (error) {
        logger.warn('[TendermintRpcClient] getBlock failed', {
          height,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },

    async getLatestBlockHeight(abortSignal?: AbortSignal): Promise<number> {
      try {
        const status = await retryWithBackoff(
          () => callRpc<{ sync_info?: { latest_block_height?: string } }>('status', {}, abortSignal),
          3,
          500,
          5000,
          abortSignal,
        )
        const height = status?.sync_info?.latest_block_height
        if (!height) {
          throw new Error('Latest block height not found in status response')
        }
        return Number.parseInt(height, 10)
      } catch (error) {
        logger.warn('[TendermintRpcClient] getLatestBlockHeight failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },

    async broadcastTxSync(
      txBytes: string,
      abortSignal?: AbortSignal,
    ): Promise<TendermintBroadcastTxResponse> {
      try {
        // Use JSON-RPC format via POST (same as other RPC calls)
        // The transaction bytes are base64-encoded and passed in params.tx
        // Note: This may trigger CORS preflight, but RPC endpoints typically have better CORS support than LCD
        // The params object gets serialized as JSON: {"tx": "base64string"}
        logger.debug('[TendermintRpcClient] broadcast_tx_sync request', {
          txBytesLength: txBytes.length,
          txBytesPrefix: txBytes.substring(0, 20) + '...',
        })
        
        const result = await retryWithBackoff(
          () => callRpc<TendermintBroadcastTxResponse>(
            'broadcast_tx_sync',
            { tx: txBytes },
            abortSignal,
          ),
          3,
          500,
          5000,
          abortSignal,
        )
        
        logger.debug('[TendermintRpcClient] broadcast_tx_sync result', {
          hash: result.hash,
          code: result.code,
          log: result.log,
        })
        
        return result
      } catch (error) {
        logger.error('[TendermintRpcClient] broadcast_tx_sync failed', {
          error: error instanceof Error ? error.message : String(error),
          txBytesLength: txBytes.length,
        })
        throw error
      }
    },
  }
}

/**
 * Get Tendermint RPC URL for a chain
 * Falls back to environment variable if not configured in chain config.
 * 
 * @deprecated Use getEffectiveRpcUrl from customUrlResolver instead
 * @param chainKey - Chain key (e.g., 'noble-testnet', 'namada-testnet')
 * @returns RPC URL
 */
export async function getTendermintRpcUrl(_chainKey: string): Promise<string> {
  // Tendermint chain support has been removed
  throw new Error('Tendermint chain support has been removed from this version')
}

/**
 * Get Tendermint LCD URL for a chain
 * NOTE: Tendermint chain support has been removed.
 */
export async function getTendermintLcdUrl(_chainKey: string): Promise<string> {
  throw new Error('Tendermint chain support has been removed from this version')
}

/**
 * Get Tendermint Indexer URL for a chain
 * NOTE: Tendermint chain support has been removed.
 */
export async function getTendermintIndexerUrl(_chainKey: string): Promise<string> {
  throw new Error('Tendermint chain support has been removed from this version')
}

/**
 * Get Tendermint MASP Indexer URL for a chain
 * NOTE: Tendermint chain support has been removed.
 */
export async function getTendermintMaspIndexerUrl(_chainKey: string): Promise<string | undefined> {
  return undefined
}

/**
 * Get Tendermint Chain ID for a chain
 * NOTE: Tendermint chain support has been removed.
 */
export async function getTendermintChainId(chainKey: string): Promise<string> {
  // Fallback to env variable (only for Namada chains)
  if (chainKey === 'namada-testnet' || chainKey.startsWith('namada')) {
    const { env } = await import('@/config/env')
    const chainId = env.namadaChainId()
    if (!chainId) {
      throw new Error('Namada chain ID not configured')
    }
    return chainId
  }

  throw new Error(`Chain ID not found for Tendermint chain: ${chainKey}`)
}

