// ABOUTME: Loads pre-bundled ZK circuit artifacts from /public/artifacts into the Railgun SDK cache.
// ABOUTME: Avoids flaky IPFS downloads in local dev; mirrors usdc-v2-frontend test-artifacts.ts.

import type { Artifact } from '@railgun-community/shared-models'

const CIRCUIT_CONFIGS = [
  { nullifiers: 1, commitments: 2 },
  { nullifiers: 2, commitments: 2 },
  { nullifiers: 2, commitments: 3 },
  { nullifiers: 8, commitments: 4 },
] as const

function configToVariant(config: { nullifiers: number; commitments: number }): string {
  return `${config.nullifiers}x${config.commitments}`
}

function configToDirName(config: { nullifiers: number; commitments: number }): string {
  return `${config.nullifiers.toString().padStart(2, '0')}x${config.commitments.toString().padStart(2, '0')}`
}

async function fetchBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function loadCircuitArtifact(config: {
  nullifiers: number
  commitments: number
}): Promise<Artifact> {
  const dirName = configToDirName(config)
  const basePath = `/artifacts/${dirName}`
  const [zkey, wasm, vkey] = await Promise.all([
    fetchBinary(`${basePath}/zkey`),
    fetchBinary(`${basePath}/circuit.wasm`),
    fetchJson<object>(`${basePath}/vkey.json`),
  ])
  return { zkey, wasm, vkey, dat: undefined }
}

export async function checkTestArtifactsAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/artifacts/01x02/vkey.json', { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

/** Inject bundled circuits into the SDK memory cache (call before proof generation). */
export async function loadTestArtifacts(): Promise<void> {
  const { artifactCache, overrideArtifact } = await import('@railgun-community/wallet')
  for (const config of CIRCUIT_CONFIGS) {
    const artifact = await loadCircuitArtifact(config)
    overrideArtifact(configToVariant(config), artifact)
  }
  void artifactCache
}
