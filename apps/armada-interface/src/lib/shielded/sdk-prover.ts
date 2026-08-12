// ABOUTME: Write-capable @armada/sdk wiring — a same-thread snarkjs ProverAdapter + an ArtifactSource
// ABOUTME: that resolves circuits from the interface's in-memory artifact registry (artifactGetter).

import {
  createWorkerProver,
  webWorkerChannel,
  type ArtifactSet,
  type ArtifactSource,
  type BrowserWorkerLike,
  type CircuitShape,
  type ProverAdapter,
  type WorkerChannel,
} from '@armada/sdk'
import { armadaVariantKey, getArmadaArtifact } from './artifactGetter'

/**
 * A `WorkerChannel` over a browser Web Worker running the SDK's prebuilt prover entry.
 *
 * `@armada/sdk/prover/worker` is the SDK-maintained, self-wiring worker module — it installs its own
 * `onmessage` handler around `createProverWorkerHandler` and imports ONLY the lean `@armada/sdk/prover`
 * subpath (snarkjs, no 13MB wasm-inlined root), so Vite bundles a small worker chunk. Pairing it with
 * `webWorkerChannel` keeps the two-phase `proof:progress` (witness → proving) flowing to the main thread.
 */
function createProverWorkerChannel(): WorkerChannel {
  const worker = new Worker(new URL('@armada/sdk/prover/worker', import.meta.url), { type: 'module' })
  // The DOM `Worker.onmessage` param is `MessageEvent` — wider than `BrowserWorkerLike`'s `{ data }`,
  // so it fails `strictFunctionTypes` assignability. `webWorkerChannel` only reads `event.data`, so the
  // shapes are runtime-compatible; narrow at the boundary rather than pull the DOM lib into the SDK.
  return webWorkerChannel(worker as unknown as BrowserWorkerLike)
}

/**
 * Off-main-thread Groth16 prover — snarkjs runs in a Web Worker so proving never blocks the UI
 * (replaces the engine's `yieldToPaint` main-thread block). The worker is created LAZILY on first
 * prove, so read-only sessions (which never prove) don't spawn one. `close()` terminates it.
 */
export function createInterfaceProver(): ProverAdapter {
  let inner: ProverAdapter | undefined
  const ensure = (): ProverAdapter => {
    if (inner === undefined) inner = createWorkerProver(createProverWorkerChannel())
    return inner
  }
  return {
    prove: (input, artifacts, options) => ensure().prove(input, artifacts, options),
    verify: (proof, signals, vkey) => ensure().verify(proof, signals, vkey),
    close: async () => {
      if (inner !== undefined) await inner.close()
    },
  }
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
