// ABOUTME: In-memory ZK-circuit artifact registry, keyed by circuit shape (padded NNxMM).
// ABOUTME: Populated by the origin preload (artifacts.ts); read by the @armada/sdk ArtifactSource (sdk-prover.ts).

/**
 * A ZK circuit artifact set — the compiled `wasm`, proving key (`zkey`), and verification key
 * (`vkey`) for one circuit shape. `dat` is an optional legacy field some artifact bundles carry;
 * unused here. Structurally matches the fields the prover reads (see sdk-prover.ts).
 */
export interface ArmadaArtifact {
  readonly wasm?: Uint8Array
  readonly zkey?: Uint8Array
  readonly vkey?: object
  readonly dat?: Uint8Array
}

// A circuit is identified by its shape — the number of nullifiers (inputs) and commitments
// (outputs). We key the registry by the padded `NNxMM` string the SDK uses so the artifact loader
// and the SDK's ArtifactSource agree without a translation layer.
const armadaArtifacts = new Map<string, ArmadaArtifact>()

/** Padded shape key, e.g. (1, 2) → "01x02". Matches the SDK's artifact-variant string format. */
export function armadaVariantKey(nullifiers: number, commitments: number): string {
  return `${nullifiers.toString().padStart(2, '0')}x${commitments.toString().padStart(2, '0')}`
}

/** Register a circuit artifact for a shape. Called by the origin preload (see artifacts.ts). */
export function setArmadaArtifact(variant: string, artifact: ArmadaArtifact): void {
  armadaArtifacts.set(variant, artifact)
}

export function hasArmadaArtifact(variant: string): boolean {
  return armadaArtifacts.has(variant)
}

/** Look up a registered circuit artifact by padded shape key. Used by the @armada/sdk ArtifactSource. */
export function getArmadaArtifact(variant: string): ArmadaArtifact | undefined {
  return armadaArtifacts.get(variant)
}

/** Drop all registered artifacts. For hot-reload + test isolation. */
export function clearArmadaArtifacts(): void {
  armadaArtifacts.clear()
}
