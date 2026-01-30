/**
 * Browser Artifact Store for Railgun Wallet SDK
 *
 * Uses IndexedDB to cache ZK circuit artifacts.
 * See: https://docs.railgun.org/developer-guide/wallet/getting-started/4.-artifact-store
 */

import { ArtifactStore } from '@railgun-community/wallet'

// IndexedDB database name for artifacts
const ARTIFACT_DB_NAME = 'railgun-artifacts'
const ARTIFACT_STORE_NAME = 'artifacts'

/**
 * Open IndexedDB for artifact storage
 */
function openArtifactDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTIFACT_DB_NAME, 1)

    request.onerror = () => {
      console.error('[artifacts] Failed to open IndexedDB:', request.error)
      reject(request.error)
    }
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = () => {
      console.log('[artifacts] Creating IndexedDB object store')
      const db = request.result
      if (!db.objectStoreNames.contains(ARTIFACT_STORE_NAME)) {
        db.createObjectStore(ARTIFACT_STORE_NAME)
      }
    }
  })
}

/**
 * Get artifact from IndexedDB
 */
async function getArtifact(path: string): Promise<string | Buffer | null> {
  console.log('[artifacts] Getting artifact:', path)
  try {
    const db = await openArtifactDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARTIFACT_STORE_NAME, 'readonly')
      const store = tx.objectStore(ARTIFACT_STORE_NAME)
      const request = store.get(path)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result
        if (result) {
          console.log('[artifacts] Found cached artifact:', path)
        }
        resolve(result ?? null)
      }
    })
  } catch (err) {
    console.error('[artifacts] Error getting artifact:', err)
    return null
  }
}

/**
 * Store artifact in IndexedDB
 */
async function storeArtifact(
  dir: string,
  path: string,
  item: string | Uint8Array,
): Promise<void> {
  console.log(
    '[artifacts] Storing artifact:',
    path,
    'dir:',
    dir,
    'size:',
    typeof item === 'string' ? item.length : item.byteLength,
  )
  try {
    const db = await openArtifactDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARTIFACT_STORE_NAME, 'readwrite')
      const store = tx.objectStore(ARTIFACT_STORE_NAME)
      const request = store.put(item, path)

      request.onerror = () => {
        console.error('[artifacts] Failed to store artifact:', request.error)
        reject(request.error)
      }
      request.onsuccess = () => {
        console.log('[artifacts] Stored artifact:', path)
        resolve()
      }
    })
  } catch (err) {
    console.error('[artifacts] Error storing artifact:', err)
    throw err
  }
}

/**
 * Check if artifact exists in IndexedDB
 */
async function artifactExists(path: string): Promise<boolean> {
  try {
    const artifact = await getArtifact(path)
    const exists = artifact !== null
    console.log('[artifacts] Checking if exists:', path, '->', exists)
    return exists
  } catch {
    return false
  }
}

/**
 * Create ArtifactStore for browser environment
 */
export function createBrowserArtifactStore(): ArtifactStore {
  console.log('[artifacts] Creating browser artifact store')
  return new ArtifactStore(getArtifact, storeArtifact, artifactExists)
}

/**
 * Clear all cached artifacts from IndexedDB
 *
 * This is useful when switching between different artifact sets
 * (e.g., from IPFS artifacts to test artifacts).
 */
export async function clearArtifactCache(): Promise<void> {
  console.log('[artifacts] Clearing IndexedDB artifact cache...')
  try {
    const db = await openArtifactDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ARTIFACT_STORE_NAME, 'readwrite')
      const store = tx.objectStore(ARTIFACT_STORE_NAME)
      const request = store.clear()

      request.onerror = () => {
        console.error('[artifacts] Failed to clear cache:', request.error)
        reject(request.error)
      }
      request.onsuccess = () => {
        console.log('[artifacts] IndexedDB artifact cache cleared')
        resolve()
      }
    })
  } catch (err) {
    console.error('[artifacts] Error clearing cache:', err)
    throw err
  }
}
