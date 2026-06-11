// ABOUTME: IndexedDB caching for crowdfund events and ENS names.
// ABOUTME: Provides persistent storage to avoid refetching on page reload.

import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { CrowdfundEvent } from './events.js'

const DB_NAME = 'armada-crowdfund'
// v2: events store moved from autoIncrement (append-only, duplicating) to a
// composite [transactionHash, logIndex] keyPath so re-fetched logs are
// idempotent. Bumping the version drops + recreates the events store — safe,
// it's only a cache.
const DB_VERSION = 2
const EVENTS_STORE = 'events'
const ENS_STORE = 'ens'
const META_STORE = 'meta'

/** Meta key holding the deployment the events store currently belongs to. */
const DEPLOYMENT_META_KEY = 'deployment'

/** 24 hours in milliseconds */
const ENS_TTL_MS = 24 * 60 * 60 * 1000

interface EnsCacheEntry {
  name: string
  timestamp: number
}

/** Identifies the deployment a cached event set belongs to. The event cache is
 *  namespaced by this so switching networks/contracts can't mix histories. */
export interface CacheDeployment {
  chainId: number
  contractAddress: string
}

function normalizeDeployment(d: CacheDeployment): CacheDeployment {
  return { chainId: d.chainId, contractAddress: d.contractAddress.toLowerCase() }
}

/** Meta key for this deployment's block cursor — namespaced so a switch can't
 *  reuse another deployment's cursor against an empty/foreign event store. */
function cursorKey(d: CacheDeployment): string {
  const n = normalizeDeployment(d)
  return `lastBlock:${n.chainId}:${n.contractAddress}`
}

function sameDeployment(a: CacheDeployment | undefined, b: CacheDeployment): boolean {
  if (!a) return false
  const na = normalizeDeployment(a)
  const nb = normalizeDeployment(b)
  return na.chainId === nb.chainId && na.contractAddress === nb.contractAddress
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Drop + recreate the events store with a composite keyPath so writes
        // are idempotent (put() dedups on [transactionHash, logIndex]).
        if (db.objectStoreNames.contains(EVENTS_STORE)) {
          db.deleteObjectStore(EVENTS_STORE)
        }
        db.createObjectStore(EVENTS_STORE, { keyPath: ['transactionHash', 'logIndex'] })
        if (!db.objectStoreNames.contains(ENS_STORE)) {
          db.createObjectStore(ENS_STORE)
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE)
        }
      },
    })
  }
  return dbPromise
}

/**
 * Ensure the events store belongs to the active deployment. If the stored
 * deployment differs (or is absent), clear the events store and reset this
 * deployment's cursor, then record the active deployment. A no-op once the
 * stored deployment matches.
 */
async function ensureDeployment(
  db: IDBPDatabase,
  deployment: CacheDeployment,
): Promise<void> {
  const stored = (await db.get(META_STORE, DEPLOYMENT_META_KEY)) as
    | CacheDeployment
    | undefined
  if (sameDeployment(stored, deployment)) return

  const tx = db.transaction([EVENTS_STORE, META_STORE], 'readwrite')
  await tx.objectStore(EVENTS_STORE).clear()
  // Reset the cursor for the deployment we are switching TO, so a return visit
  // (A → B → A) re-scans from scratch rather than trusting a stale cursor
  // against the now-cleared event store.
  await tx.objectStore(META_STORE).delete(cursorKey(deployment))
  await tx.objectStore(META_STORE).put(normalizeDeployment(deployment), DEPLOYMENT_META_KEY)
  await tx.done
}

/** Get cached events (oldest first) and the last fetched block for a deployment */
export async function getCachedEvents(deployment: CacheDeployment): Promise<{
  events: CrowdfundEvent[]
  lastBlock: number
}> {
  const db = await getDB()
  await ensureDeployment(db, deployment)
  const events = (await db.getAll(EVENTS_STORE)) as CrowdfundEvent[]
  // getAll() returns key order ([txHash, logIndex]); restore chronological
  // order so the "oldest first" contract holds for graph logic.
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  const lastBlock = ((await db.get(META_STORE, cursorKey(deployment))) as number) ?? 0
  return { events, lastBlock }
}

/** Idempotently store events and advance the deployment's block cursor */
export async function cacheEvents(
  events: CrowdfundEvent[],
  lastBlock: number,
  deployment: CacheDeployment,
): Promise<void> {
  const db = await getDB()
  await ensureDeployment(db, deployment)
  const tx = db.transaction([EVENTS_STORE, META_STORE], 'readwrite')
  const eventStore = tx.objectStore(EVENTS_STORE)
  for (const event of events) {
    // put() (not add()) — idempotent on the [transactionHash, logIndex] key.
    await eventStore.put(event)
  }
  await tx.objectStore(META_STORE).put(lastBlock, cursorKey(deployment))
  await tx.done
}

/** Get a cached ENS name for an address (respects TTL) */
export async function getCachedENS(address: string): Promise<string | null> {
  const db = await getDB()
  const entry = (await db.get(ENS_STORE, address.toLowerCase())) as
    | EnsCacheEntry
    | undefined
  if (!entry) return null
  if (Date.now() - entry.timestamp > ENS_TTL_MS) return null
  return entry.name
}

/** Cache an ENS name for an address */
export async function cacheENS(address: string, name: string): Promise<void> {
  const db = await getDB()
  const entry: EnsCacheEntry = { name, timestamp: Date.now() }
  await db.put(ENS_STORE, entry, address.toLowerCase())
}

/** Batch get cached ENS names for multiple addresses */
export async function batchGetCachedENS(
  addresses: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const db = await getDB()
  const now = Date.now()
  for (const addr of addresses) {
    const entry = (await db.get(ENS_STORE, addr.toLowerCase())) as
      | EnsCacheEntry
      | undefined
    if (entry && now - entry.timestamp <= ENS_TTL_MS) {
      result.set(addr.toLowerCase(), entry.name)
    }
  }
  return result
}

/** Clear all caches (useful for debugging stale state) */
export async function clearCache(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([EVENTS_STORE, ENS_STORE, META_STORE], 'readwrite')
  await tx.objectStore(EVENTS_STORE).clear()
  await tx.objectStore(ENS_STORE).clear()
  await tx.objectStore(META_STORE).clear()
  await tx.done
}

/** Reset the module-level DB promise (for testing) */
export function _resetDB(): void {
  dbPromise = null
}
