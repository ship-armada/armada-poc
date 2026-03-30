// ABOUTME: IndexedDB caching for crowdfund events and ENS names.
// ABOUTME: Provides persistent storage to avoid refetching on page reload.

import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { CrowdfundEvent } from './events.js'

const DB_NAME = 'armada-crowdfund'
const DB_VERSION = 1
const EVENTS_STORE = 'events'
const ENS_STORE = 'ens'
const META_STORE = 'meta'

/** 24 hours in milliseconds */
const ENS_TTL_MS = 24 * 60 * 60 * 1000

interface EnsCacheEntry {
  name: string
  timestamp: number
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          db.createObjectStore(EVENTS_STORE, { autoIncrement: true })
        }
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

/** Get cached events and the last fetched block number */
export async function getCachedEvents(): Promise<{
  events: CrowdfundEvent[]
  lastBlock: number
}> {
  const db = await getDB()
  const events = (await db.getAll(EVENTS_STORE)) as CrowdfundEvent[]
  const lastBlock = ((await db.get(META_STORE, 'lastBlock')) as number) ?? 0
  return { events, lastBlock }
}

/** Append new events to cache and update last block */
export async function cacheEvents(
  events: CrowdfundEvent[],
  lastBlock: number,
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([EVENTS_STORE, META_STORE], 'readwrite')
  const eventStore = tx.objectStore(EVENTS_STORE)
  for (const event of events) {
    await eventStore.add(event)
  }
  await tx.objectStore(META_STORE).put(lastBlock, 'lastBlock')
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
