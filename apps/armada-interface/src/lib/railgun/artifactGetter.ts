// ABOUTME: App-owned ArtifactGetter supplied as arg 3 to RailgunEngine.initForWallet.
// ABOUTME: The wallet SDK's download-just-in-time getter isn't exported, so we serve Armada circuits from our own in-memory registry.

import type { Artifact } from '@railgun-community/shared-models'
import type { ArtifactGetter } from '@railgun-community/engine'

// The engine identifies a circuit by its shape — the number of nullifiers (inputs) and
// commitments (outputs). We key the registry by the same padded `NNxMM` string the SDK uses so
// the DEV circuit loader and this getter agree without a translation layer.
const armadaArtifacts = new Map<string, Artifact>()

/** Padded shape key, e.g. (1, 2) → "01x02". Matches the SDK's artifact-variant string format. */
export function armadaVariantKey(nullifiers: number, commitments: number): string {
  return `${nullifiers.toString().padStart(2, '0')}x${commitments.toString().padStart(2, '0')}`
}

/** Register a circuit artifact for a shape. Called by the DEV circuit loader (see init.ts). */
export function setArmadaArtifact(variant: string, artifact: Artifact): void {
  armadaArtifacts.set(variant, artifact)
}

export function hasArmadaArtifact(variant: string): boolean {
  return armadaArtifacts.has(variant)
}

/** Look up a registered circuit artifact by padded shape key. Used by the @armada/sdk ArtifactSource. */
export function getArmadaArtifact(variant: string): Artifact | undefined {
  return armadaArtifacts.get(variant)
}

/** Drop all registered artifacts. For hot-reload + test isolation. */
export function clearArmadaArtifacts(): void {
  armadaArtifacts.clear()
}

/**
 * The getter the engine calls during proof generation. Unlike the SDK's download-just-in-time
 * getter (which pulls from IPFS and hash-validates against Railgun's manifest), ours serves the
 * Armada circuits registered up-front by the DEV loader — the same bypass `overrideArtifact`
 * gave us, but through a getter we own rather than the SDK's non-exported internal one.
 *
 * `getArtifacts` / `assertArtifactExists` are only reached on the proof-generating paths
 * (unshield / transfer), which run well after the DEV loader has populated the registry. The
 * merkletree scan does not consume circuit artifacts, so an empty registry during sync is fine.
 */
export const armadaArtifactGetter: ArtifactGetter = {
  // Called synchronously by the engine's prover before getArtifacts to fail fast on an
  // unsupported shape. Our registry is the source of truth for what this pool can prove.
  assertArtifactExists: (nullifiers: number, commitments: number): void => {
    const key = armadaVariantKey(nullifiers, commitments)
    if (!armadaArtifacts.has(key)) {
      throw new Error(
        `[shielded.artifactGetter] no Armada artifact registered for ${key}; ` +
          'ensure the circuit loader ran before proof generation',
      )
    }
  },

  getArtifacts: async (publicInputs): Promise<Artifact> => {
    const key = armadaVariantKey(publicInputs.nullifiers.length, publicInputs.commitmentsOut.length)
    const artifact = armadaArtifacts.get(key)
    if (!artifact) {
      throw new Error(
        `[shielded.artifactGetter] no Armada artifact registered for ${key}; ` +
          'ensure the circuit loader ran before proof generation',
      )
    }
    return artifact
  },

  // POI is disabled in this deployment (dummy node interface in init.ts). If the engine ever
  // asks for a POI artifact, that's a misconfiguration — fail loudly rather than return garbage.
  getArtifactsPOI: async (maxInputs: number, maxOutputs: number): Promise<Artifact> => {
    throw new Error(
      `[shielded.artifactGetter] POI artifacts unavailable (POI disabled): POI_${maxInputs}x${maxOutputs}`,
    )
  },
}
