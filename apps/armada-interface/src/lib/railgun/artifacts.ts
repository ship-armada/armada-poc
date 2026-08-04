// ABOUTME: IndexedDB-backed ArtifactStore for the Railgun SDK — caches ZK circuit artifacts (zkey/wasm/vkey) across reloads.
// ABOUTME: Ported from usdc-v2-frontend/src/lib/railgun/artifacts.ts; same DB name + store name so users with the legacy app's cache see it preserved.

import type { Artifact } from '@railgun-community/shared-models'
import { setArmadaArtifact, armadaVariantKey } from './artifactGetter'

// The SDK's ArtifactStore class lives in @railgun-community/wallet — which transitively pulls
// circomlibjs and crashes at module-load under jsdom. We dynamic-import it so vitest can load
// callers (init.ts, wallet.ts) without instantiating the engine surface. One import per session.
type RailgunSdk = typeof import('@railgun-community/wallet')

// Variants the demo's tx kinds actually exercise (small-UTXO unshield / transfer / yield). The
// heavy 8x4 (large multi-input) variant is intentionally NOT preloaded — it's ~30 MB and rarely
// hit; the SDK's IPFS read-through cache (createBrowserArtifactStore) covers it when it is.
const PRELOAD_VARIANTS = [
  { nullifiers: 1, commitments: 2 },
  { nullifiers: 2, commitments: 2 },
  { nullifiers: 2, commitments: 3 },
] as const

function variantDir(c: { nullifiers: number; commitments: number }): string {
  return `${c.nullifiers.toString().padStart(2, '0')}x${c.commitments.toString().padStart(2, '0')}`
}

async function fetchArtifactBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`artifact fetch ${url} → ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchArtifactJson(url: string): Promise<object> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`artifact fetch ${url} → ${res.status}`)
  return res.json() as Promise<object>
}

/** Probe whether self-hosted artifacts are served at /artifacts (the prebuild copies them in). */
async function originArtifactsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`/artifacts/${variantDir(PRELOAD_VARIANTS[0])}/vkey.json`, { method: 'HEAD' })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Preload the demo-critical circuit artifacts from the app's OWN origin (`/artifacts/...`) into our
 * ArtifactGetter registry (see artifactGetter.ts), so the first proof doesn't fetch ~10 MB from a
 * public IPFS gateway at click time mid-demo (P0-12). Fire-and-forget after engine init, off the
 * critical path. This is the prod counterpart to the DEV-only loadArmadaCircuits in init.ts — both
 * feed the same getter registry.
 *
 * Silent no-op when the artifacts aren't served, and per-variant failures don't abort the rest.
 * (Renamed from the dead `loadTestArtifacts`.)
 */
export async function preloadArtifactsFromOrigin(): Promise<void> {
  if (!(await originArtifactsAvailable())) return
  for (const c of PRELOAD_VARIANTS) {
    try {
      const dir = variantDir(c)
      const [zkey, wasm, vkey] = await Promise.all([
        fetchArtifactBinary(`/artifacts/${dir}/zkey`),
        fetchArtifactBinary(`/artifacts/${dir}/circuit.wasm`),
        fetchArtifactJson(`/artifacts/${dir}/vkey.json`),
      ])
      // Register under the padded NNxMM key the getter looks up (armadaVariantKey), so proof
      // generation resolves these. Bypasses the SDK's IPFS + hash-manifest path entirely.
      setArmadaArtifact(armadaVariantKey(c.nullifiers, c.commitments), {
        zkey,
        wasm,
        vkey,
        dat: undefined,
      } as Artifact)
    } catch {
      // One variant failing (404 / partial deploy) must not abort the others or crash the app.
      // Silent: no console in lib/railgun (secret hygiene).
    }
  }
}

const ARTIFACT_DB_NAME = 'railgun-artifacts'
const ARTIFACT_STORE_NAME = 'artifacts'

function openArtifactDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTIFACT_DB_NAME, 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ARTIFACT_STORE_NAME)) {
        db.createObjectStore(ARTIFACT_STORE_NAME)
      }
    }
  })
}

async function getArtifact(path: string): Promise<string | Buffer | null> {
  try {
    const db = await openArtifactDB()
    return await new Promise<string | Buffer | null>((resolve, reject) => {
      const tx = db.transaction(ARTIFACT_STORE_NAME, 'readonly')
      const store = tx.objectStore(ARTIFACT_STORE_NAME)
      const request = store.get(path)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve((request.result as string | Buffer | undefined) ?? null)
    })
  } catch {
    return null
  }
}

async function storeArtifact(_dir: string, path: string, item: string | Uint8Array): Promise<void> {
  const db = await openArtifactDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ARTIFACT_STORE_NAME, 'readwrite')
    const store = tx.objectStore(ARTIFACT_STORE_NAME)
    const request = store.put(item, path)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    return (await getArtifact(path)) !== null
  } catch {
    return false
  }
}

/**
 * Build the ArtifactStore the SDK consumes when it needs a circuit artifact. The store is a
 * read-through cache: when the SDK asks for an artifact isn't there, it falls back to the
 * built-in IPFS loader, then writes the result here for next time.
 *
 * Async because the SDK's `ArtifactStore` constructor is behind a dynamic import (jsdom crash
 * mitigation). Callers must `await` this.
 */
export async function createBrowserArtifactStore(): Promise<InstanceType<RailgunSdk['ArtifactStore']>> {
  const { ArtifactStore } = await import('@railgun-community/wallet')
  return new ArtifactStore(getArtifact, storeArtifact, artifactExists)
}

/**
 * Clear all cached artifacts. Used when switching between artifact sources (e.g. preloaded test
 * artifacts vs IPFS). Safe to call from anywhere; idempotent on an empty / non-existent DB.
 */
export async function clearArtifactCache(): Promise<void> {
  try {
    const db = await openArtifactDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ARTIFACT_STORE_NAME, 'readwrite')
      const store = tx.objectStore(ARTIFACT_STORE_NAME)
      const request = store.clear()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch {
    /* swallow — DB may not exist yet */
  }
}
