/**
 * Native token price service for fetching native token prices from Binance Public API.
 * This service provides USD estimates for native token amounts (ETH, AVAX, POL, etc.).
 */

import { logger } from '@/utils/logger'
import { env } from '@/config/env'

// Map chain key to Binance symbol
const BINANCE_SYMBOL_MAP: Record<string, string> = {
  'ethereum': 'ETHUSDT',
  'sepolia': 'ETHUSDT', // testnet uses mainnet price
  'base': 'ETHUSDT',
  'base-sepolia': 'ETHUSDT',
  'polygon': 'MATICUSDT',
  'polygon-amoy': 'MATICUSDT',
  'arbitrum': 'ETHUSDT',
  'avalanche': 'AVAXUSDT',
  'avalanche-fuji': 'AVAXUSDT',
}

// Price cache (in-memory, 5 minute TTL)
interface PriceCacheEntry {
  price: number
  timestamp: number
}

const priceCache = new Map<string, PriceCacheEntry>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Fetches native token price from Binance Public API.
 * Uses caching to reduce API calls (5 minute TTL).
 *
 * @param chainKey - The chain key (e.g., 'sepolia', 'base', 'polygon')
 * @returns Native token price in USD, or null if fetch fails
 */
export async function fetchNativeTokenPrice(chainKey: string): Promise<number | null> {
  const symbol = BINANCE_SYMBOL_MAP[chainKey]
  if (!symbol) {
    logger.debug('[PriceService] No Binance symbol mapping for chain', { chainKey })
    return null
  }

  // Check cache first
  const cached = priceCache.get(chainKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug('[PriceService] Using cached price', { chainKey, price: cached.price })
    return cached.price
  }

  try {
    const baseUrl = env.binanceApiBaseUrl()
    const url = `${baseUrl}/api/v3/ticker/price?symbol=${symbol}`
    logger.debug('[PriceService] Fetching price from Binance', { chainKey, symbol, url })

    const response = await fetch(url)
    if (!response.ok) {
      logger.warn('[PriceService] Binance API error', {
        chainKey,
        symbol,
        status: response.status,
        statusText: response.statusText,
      })
      return null
    }

    const data = await response.json()
    const price = parseFloat(data.price)

    if (isNaN(price) || price <= 0) {
      logger.warn('[PriceService] Invalid price from Binance', {
        chainKey,
        symbol,
        price: data.price,
      })
      return null
    }

    // Update cache
    priceCache.set(chainKey, { price, timestamp: Date.now() })

    logger.debug('[PriceService] Price fetched successfully', {
      chainKey,
      symbol,
      price,
    })

    return price
  } catch (error) {
    logger.warn('[PriceService] Binance price fetch failed', {
      chainKey,
      symbol,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Clears the price cache for a specific chain or all chains.
 *
 * @param chainKey - Optional chain key to clear. If not provided, clears all caches.
 */
export function clearPriceCache(chainKey?: string): void {
  if (chainKey) {
    priceCache.delete(chainKey)
    logger.debug('[PriceService] Cleared price cache', { chainKey })
  } else {
    priceCache.clear()
    logger.debug('[PriceService] Cleared all price caches')
  }
}

