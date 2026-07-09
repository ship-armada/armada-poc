/**
 * Test Artifact Loader for Browser
 *
 * Loads the pre-decompressed test artifacts from /public/artifacts
 * and injects them into the SDK's artifact cache using overrideArtifact.
 *
 * This ensures that proofs generated in the browser use the same circuit
 * keys as the verification keys deployed to the contract.
 */

import { overrideArtifact, artifactCache } from '@railgun-community/wallet'
import type { Artifact } from '@railgun-community/shared-models'

// Re-export artifactCache for debugging
export { artifactCache }

// Circuit configs that are deployed to the contract
// Must match TESTING_ARTIFACT_CONFIGS in poc/lib/artifacts.ts
const CIRCUIT_CONFIGS = [
  { nullifiers: 1, commitments: 2 }, // Shield: 1 input -> 2 outputs
  { nullifiers: 2, commitments: 2 }, // Simple transfer
  { nullifiers: 2, commitments: 3 }, // Transfer with change
  { nullifiers: 8, commitments: 4 }, // Medium consolidation
]

/**
 * Convert circuit config to artifact variant string (e.g., "1x2")
 * Must match SDK's getArtifactVariantString() format
 */
function configToVariant(config: {
  nullifiers: number
  commitments: number
}): string {
  return `${config.nullifiers}x${config.commitments}`
}

/**
 * Convert circuit config to directory name (e.g., "01x02")
 */
function configToDirName(config: {
  nullifiers: number
  commitments: number
}): string {
  return `${config.nullifiers.toString().padStart(2, '0')}x${config.commitments.toString().padStart(2, '0')}`
}

/**
 * Fetch a binary file as Uint8Array
 */
async function fetchBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    )
  }
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Fetch and parse a JSON file
 */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    )
  }
  return response.json()
}

/**
 * Load a single circuit's artifacts from the public folder
 */
async function loadCircuitArtifact(config: {
  nullifiers: number
  commitments: number
}): Promise<Artifact> {
  const dirName = configToDirName(config)
  const basePath = `/artifacts/${dirName}`

  console.log(
    `[test-artifacts] Loading ${config.nullifiers}x${config.commitments}...`,
  )

  // Fetch all three files in parallel
  const [zkey, wasm, vkey] = await Promise.all([
    fetchBinary(`${basePath}/zkey`),
    fetchBinary(`${basePath}/circuit.wasm`),
    fetchJson<object>(`${basePath}/vkey.json`),
  ])

  console.log(
    `[test-artifacts] Loaded ${config.nullifiers}x${config.commitments}: zkey=${(zkey.length / 1024 / 1024).toFixed(2)}MB, wasm=${(wasm.length / 1024 / 1024).toFixed(2)}MB`,
  )

  return {
    zkey,
    wasm,
    vkey,
    dat: undefined, // Not needed for our circuits
  }
}

/**
 * Load and inject all test artifacts into the SDK's cache
 *
 * This function should be called after the SDK engine is started
 * but before any proof generation.
 */
export async function loadTestArtifacts(): Promise<void> {
  console.log('[test-artifacts] Loading test artifacts for browser...')

  for (const config of CIRCUIT_CONFIGS) {
    try {
      const artifact = await loadCircuitArtifact(config)
      const variant = configToVariant(config)

      // Log artifact details for debugging
      console.log(`[test-artifacts] Artifact ${variant} details:`, {
        zkeyLength:
          artifact.zkey instanceof Uint8Array
            ? artifact.zkey.length
            : 'not Uint8Array',
        wasmLength:
          artifact.wasm instanceof Uint8Array
            ? artifact.wasm.length
            : 'not Uint8Array',
        vkeyProtocol: (artifact.vkey as Record<string, unknown>)?.protocol,
        vkeyCurve: (artifact.vkey as Record<string, unknown>)?.curve,
        vkeyNPublic: (artifact.vkey as Record<string, unknown>)?.nPublic,
      })

      // Inject into SDK's artifact cache
      overrideArtifact(variant, artifact)

      console.log(`[test-artifacts] Injected artifact ${variant} into SDK cache`)
    } catch (error) {
      console.error(
        `[test-artifacts] Failed to load artifact ${config.nullifiers}x${config.commitments}:`,
        error,
      )
      throw error
    }
  }

  console.log(
    `[test-artifacts] Successfully loaded ${CIRCUIT_CONFIGS.length} test artifacts`,
  )

  // Verify the cache contains our artifacts
  console.log('[test-artifacts] Verifying SDK artifact cache...')
  const cacheKeys = Object.keys(artifactCache)
  console.log('[test-artifacts] Cache keys:', cacheKeys)
  for (const key of cacheKeys) {
    const cached = artifactCache[key]
    if (cached) {
      console.log(`[test-artifacts] Cache[${key}]:`, {
        hasZkey: !!cached.zkey,
        hasWasm: !!cached.wasm,
        hasVkey: !!cached.vkey,
        zkeyType: cached.zkey?.constructor?.name,
        wasmType: cached.wasm?.constructor?.name,
      })
    }
  }
}

/**
 * Check if test artifacts are available (files exist)
 */
export async function checkTestArtifactsAvailable(): Promise<boolean> {
  try {
    // Just check if one of the vkey files exists
    const response = await fetch('/artifacts/01x02/vkey.json', {
      method: 'HEAD',
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get list of circuit variants that have been loaded
 */
export function getLoadedCircuits(): string[] {
  return CIRCUIT_CONFIGS.map(configToVariant)
}

/**
 * Check if a specific circuit is loaded
 */
export function isCircuitLoaded(
  nullifiers: number,
  commitments: number,
): boolean {
  const variant = `${nullifiers}x${commitments}`
  return variant in artifactCache && !!artifactCache[variant]
}
