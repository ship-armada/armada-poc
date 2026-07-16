import { saveItem, loadItem, deleteItem } from './localStore'

const STORAGE_KEY = 'custom-chain-urls'

export interface StoredCustomChainUrls {
  evm: Record<string, CustomChainUrls>
}

export interface CustomChainUrls {
  rpcUrl?: string
}

/**
 * Load custom chain URLs from localStorage
 */
export function loadCustomChainUrls(): StoredCustomChainUrls | undefined {
  return loadItem<StoredCustomChainUrls>(STORAGE_KEY)
}

/**
 * Save custom chain URLs to localStorage
 */
export function saveCustomChainUrls(urls: StoredCustomChainUrls): void {
  saveItem(STORAGE_KEY, urls)
}

/**
 * Clear all custom chain URLs from localStorage
 */
export function clearCustomChainUrls(): void {
  deleteItem(STORAGE_KEY)
}
