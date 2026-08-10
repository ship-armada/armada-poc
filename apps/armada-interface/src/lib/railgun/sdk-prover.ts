// ABOUTME: Write-capable @armada/sdk wiring — a same-thread snarkjs ProverAdapter + an ArtifactSource
// ABOUTME: that resolves circuits from the interface's in-memory artifact registry (artifactGetter).

import {
  createSnarkjsProver,
  type ArtifactSet,
  type ArtifactSource,
  type CircuitShape,
  type ProverAdapter,
} from '@armada/sdk'
import { armadaVariantKey, getArmadaArtifact } from './artifactGetter'

/**
 * Same-thread Groth16 prover (snarkjs). This is the correctness-first backend; the off-main-thread
 * worker prover (`createWorkerProver`) is a follow-on swap that every proving flow inherits, since the
 * prover is a single injected adapter on the SDK instance.
 */
export function createInterfaceProver(): ProverAdapter {
  return createSnarkjsProver()
}

/**
 * `ArtifactSource` bridging the SDK to the interface's in-memory circuit registry — the same
 * `artifactGetter` registry the engine proves against, populated by the DEV circuit loader + the prod
 * origin-preload (keyed by padded `NNxMM`). Resolves `(shape) → { wasm, zkey, vkey }`; throws if the
 * shape's circuit hasn't been loaded, so a request for an unserved shape fails loudly rather than hanging.
 */
export function createInterfaceArtifactSource(): ArtifactSource {
  return {
    async resolve(shape: CircuitShape): Promise<ArtifactSet> {
      const key = armadaVariantKey(shape.nullifiers, shape.commitments)
      const artifact = getArmadaArtifact(key)
      if (!artifact || artifact.wasm === undefined || artifact.zkey === undefined || artifact.vkey === undefined) {
        throw new Error(`sdk-prover: circuit ${key} not loaded — ensure artifacts are preloaded before proving`)
      }
      return {
        wasm: artifact.wasm as Uint8Array,
        zkey: artifact.zkey as Uint8Array,
        vkey: artifact.vkey as object,
      }
    },
  }
}
