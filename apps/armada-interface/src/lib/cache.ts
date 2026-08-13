// ABOUTME: IndexedDB cache helpers — tx history, fee quotes, ENS resolutions, balance snapshots.
// ABOUTME: Stub now (typed signatures only); implementation lands when first consumer needs it.

const DB_NAME = 'armada-interface'
const DB_VERSION = 1

export type StoreName = 'txHistory' | 'feeQuotes' | 'ens' | 'shieldedBalances' | 'meta'

const STORES: ReadonlyArray<StoreName> = ['txHistory', 'feeQuotes', 'ens', 'shieldedBalances', 'meta']

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name)
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    // Clear the cached promise on failure so a later call can retry. Without
    // this, a single transient open error (quota, blocked upgrade, etc.) would
    // poison every cache op for the rest of the page lifetime.
    req.onerror = () => {
      if (dbPromise === promise) dbPromise = null
      reject(req.error)
    }
    req.onblocked = () => {
      if (dbPromise === promise) dbPromise = null
      reject(new Error('IndexedDB open blocked (another tab holds an older version)'))
    }
  })
  // Defensive: also clear if the promise rejects for any reason not caught above.
  promise.catch(() => { if (dbPromise === promise) dbPromise = null })
  dbPromise = promise
  return dbPromise
}

export async function cacheGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function cachePut<T>(store: StoreName, key: string, value: T): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Atomic read-modify-write on ONE key in a SINGLE `readwrite` transaction. `decide` runs synchronously
 * inside the transaction with the current stored value; return `{ put }` to write, or `{ skip: true }`
 * to leave the store unchanged. Because get → decide → put all share one transaction, a compare-and-set
 * (optimistic-concurrency / terminal-state guard) is atomic — two concurrent callers can't both read the
 * same value, both pass the guard, and both write (the `cacheGet`-then-`cachePut` split can). Resolves
 * to whether a write happened.
 *
 * `decide` MUST be synchronous — any `await` inside it lets IndexedDB auto-commit the transaction before
 * the `put`, defeating the atomicity (and throwing on the late write).
 */
export async function cacheReadModifyWrite<T, V>(
  store: StoreName,
  key: string,
  decide: (existing: T | undefined) => { put: V } | { skip: true },
): Promise<boolean> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    const getReq = os.get(key)
    let wrote = false
    let settled = false
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    getReq.onsuccess = () => {
      try {
        const decision = decide(getReq.result as T | undefined)
        if ('put' in decision) {
          os.put(decision.put, key)
          wrote = true
        }
      } catch (err) {
        // A throw from decide() must not leave a half-applied state — abort the whole transaction.
        tx.abort()
        done(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    }
    getReq.onerror = () => done(() => reject(getReq.error))
    tx.oncomplete = () => done(() => resolve(wrote))
    tx.onerror = () => done(() => reject(tx.error))
    tx.onabort = () => done(() => reject(tx.error ?? new Error('cacheReadModifyWrite: transaction aborted')))
  })
}

export async function cacheDelete(store: StoreName, key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Scan an entire store. Useful for hydration on app start (e.g. resume pending txs). */
export async function cacheAll<T>(store: StoreName): Promise<Array<{ key: string; value: T }>> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const out: Array<{ key: string; value: T }> = []
    const req = tx.objectStore(store).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        out.push({ key: String(cursor.key), value: cursor.value as T })
        cursor.continue()
      } else {
        resolve(out)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Drop a single store's entries — used by Settings → Reset wallet, Reset history. */
export async function cacheClear(store: StoreName): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
