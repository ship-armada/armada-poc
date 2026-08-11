// ABOUTME: Preloads the demo-critical ZK circuit artifacts (zkey/wasm/vkey) from the app's own origin
// ABOUTME: into the in-memory artifact registry (artifactGetter), so the first proof doesn't fetch from IPFS.

import { setArmadaArtifact, armadaVariantKey } from './artifactGetter'

// Variants the demo's tx kinds actually exercise (small-UTXO unshield / transfer / yield). The
// heavy 8x4 (large multi-input) variant is intentionally NOT preloaded — it's ~30 MB and rarely
// hit; the SDK's default artifact fetch covers it when it is.
const PRELOAD_VARIANTS = [
  { nullifiers: 1, commitments: 2 },
  { nullifiers: 1, commitments: 3 }, // 1-input redeem/transfer with a broadcaster-fee output
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
 * Preload the demo-critical circuit artifacts from the app's OWN origin (`/artifacts/...`) into the
 * in-memory artifact registry (see artifactGetter.ts), so the first proof doesn't fetch ~10 MB from a
 * public IPFS gateway at click time mid-demo (P0-12). Fire-and-forget on app mount, off the critical
 * path. The @armada/sdk ArtifactSource (sdk-prover.ts) resolves circuits from this registry.
 *
 * Silent no-op when the artifacts aren't served, and per-variant failures don't abort the rest.
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
      // Register under the padded NNxMM key the SDK's ArtifactSource looks up (armadaVariantKey),
      // so proof generation resolves these instead of the SDK's default IPFS fetch.
      setArmadaArtifact(armadaVariantKey(c.nullifiers, c.commitments), {
        zkey,
        wasm,
        vkey,
      })
    } catch {
      // One variant failing (404 / partial deploy) must not abort the others or crash the app.
      // Silent: no console in lib/railgun (secret hygiene).
    }
  }
}
