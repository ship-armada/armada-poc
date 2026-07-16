// ABOUTME: Railgun engine bootstrap — startRailgunEngine + POI dummy + artifact store. Drives railgunEngineAtom through cold → warming → ready / failed.
// ABOUTME: Idempotent; safe to call multiple times. Engine loads the WASM proving stack (~1 MB) lazily, so we keep init off the critical path until the user needs it.

// The Railgun SDK + its transitive deps (circomlibjs, ethereum-cryptography) crash on
// module-load under jsdom. We `import()` at call time so test files that transitively pull
// in this module don't blow up before any user code runs. Production cost: one extra microtask
// the first time initRailgunEngine() runs.
import { getDefaultStore } from 'jotai'
import { createWebDatabase } from './database'
import { createBrowserArtifactStore } from './artifacts'
import { initializeProver } from './prover'
import { syncStateAtom } from '@/state/wallet'
import { trackError } from '@/lib/telemetry'

const ENGINE_DB_NAME = 'armada-shielded'
const ENGINE_WALLET_SOURCE = 'armadainf' // ≤16 chars, lowercase, no special chars — SDK constraint

let initialized = false
let inFlight: Promise<void> | null = null
let lastError: Error | null = null

/**
 * Engine lifecycle state — observable via `subscribeEngineState`. A bridge hook in `hooks/`
 * mirrors this into `railgunEngineAtom` so React UI can show a warming indicator. Lives in
 * lib/ (no React) so the wallet flow and other lib code can read engine state without going
 * through atoms; the atom is purely the UI projection.
 */
export type EngineState = 'cold' | 'warming' | 'ready' | 'failed'

interface EngineStateSnapshot {
  readonly state: EngineState
  /** When state === 'failed', the captured error. Otherwise null. */
  readonly error: string | null
}

let currentSnapshot: EngineStateSnapshot = { state: 'cold', error: null }
const listeners = new Set<(s: EngineStateSnapshot) => void>()

function setEngineState(state: EngineState, error: string | null = null): void {
  currentSnapshot = { state, error }
  for (const listener of listeners) {
    try {
      listener(currentSnapshot)
    } catch {
      /* swallow — one bad listener mustn't break the others */
    }
  }
}

export function getEngineState(): EngineStateSnapshot {
  return currentSnapshot
}

/** Subscribe to lifecycle transitions. Returns an unsubscribe function. */
export function subscribeEngineState(listener: (s: EngineStateSnapshot) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Initialize the Railgun engine. Idempotent + reentrancy-safe — multiple concurrent calls share
 * the same in-flight promise. Throws (and caches the error) on first failure; subsequent calls
 * re-throw the same error until `resetInitState()` is called.
 *
 * The flow:
 *   1. Wire SDK loggers to our own structured-log surface (no console.log of secrets — see
 *      lib/railgun/CLAUDE.md secret-handling rules).
 *   2. Create the level-js DB (IndexedDB-backed) + the artifact store (IndexedDB-backed).
 *   3. Call startRailgunEngine with our walletSource + the stores. This loads the WASM proving
 *      stack and initializes the merkle scanner.
 *   4. Install a dummy POI node interface so proof generation doesn't crash with
 *      "Cannot read properties of undefined (reading isRequired)" on local devnet where POI
 *      isn't configured.
 *
 * Test-artifact preloading (for local Anvil POC contracts) is a separate concern handled in a
 * follow-up commit; in Sepolia mode the SDK pulls artifacts from IPFS via the artifact store.
 */
export async function initRailgunEngine(): Promise<void> {
  if (initialized) return
  if (lastError) throw lastError
  if (inFlight) return inFlight
  setEngineState('warming')
  inFlight = doInit()
  try {
    await inFlight
    initialized = true
    setEngineState('ready')
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
    setEngineState('failed', lastError.message)
    throw lastError
  } finally {
    inFlight = null
  }
}

/**
 * Load Armada circuit artifacts from the Vite dev server and inject them into
 * the Railgun SDK's in-memory cache via overrideArtifact().
 *
 * In local mode, artifacts are served from armada-circuits/build/ via the
 * serveCircuitArtifacts() Vite middleware at /api/circuits/<N>x<M>/.
 *
 * Only loads the shapes registered on-chain (TESTING_ARTIFACT_CONFIGS).
 * Each shape's WASM (~4MB) + ZKEY (~13MB) are fetched once and cached for
 * the session. Lazy loading is handled by the SDK — overrideArtifact just
 * primes the cache so the first proof doesn't pay the IPFS + hash-check penalty.
 */

// The shapes registered on PrivacyPool during deployment
const ARMADA_SHAPES: Array<[number, number]> = [
  [1, 1], [1, 2], [2, 2], [2, 3], [8, 4],
  [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1],
  [3, 2], [4, 2], [5, 2], [6, 2],
  [1, 3], [3, 3], [4, 3],
]

async function loadArmadaCircuits(
  overrideArtifact: (variant: string, artifact: { wasm: Uint8Array; zkey: Uint8Array; vkey: unknown }) => void,
): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[railgun] Loading Armada circuit artifacts...')

  for (const [n, m] of ARMADA_SHAPES) {
    const variant = `${n.toString().padStart(2, '0')}x${m.toString().padStart(2, '0')}`
    const shape = `${n}x${m}`
    const base = `/api/circuits/${shape}`

    try {
      const [wasmRes, zkeyRes, vkeyRes] = await Promise.all([
        fetch(`${base}/wasm`),
        fetch(`${base}/zkey`),
        fetch(`${base}/vkey`),
      ])

      if (!wasmRes.ok || !zkeyRes.ok || !vkeyRes.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[railgun] Skipping ${variant}: artifacts not available (WASM:${wasmRes.status} ZKEY:${zkeyRes.status})`)
        continue
      }

      const wasm = new Uint8Array(await wasmRes.arrayBuffer())
      const zkey = new Uint8Array(await zkeyRes.arrayBuffer())
      const vkey = await vkeyRes.json()

      overrideArtifact(variant, { wasm, zkey, vkey })
    } catch (err) {
      // Non-fatal — the SDK will fall back to IPFS for this shape
      // eslint-disable-next-line no-console
      console.warn(`[railgun] Failed to load ${variant}:`, err)
    }
  }

  // eslint-disable-next-line no-console
  console.log('[railgun] Armada circuit artifacts loaded')
}

async function doInit(): Promise<void> {
  const [
    { startRailgunEngine, setLoggers, setOnUTXOMerkletreeScanCallback, overrideArtifact },
    { POI },
    { MerkletreeScanStatus },
  ] = await Promise.all([
    import('@railgun-community/wallet'),
    import('@railgun-community/engine'),
    import('@railgun-community/shared-models'),
  ])

  // SDK logging is verbose by design (engine lifecycle + per-block scan progress). Gate it on DEV
  // so production builds don't stream SDK internals to the console, where a future SDK change
  // could surface sensitive material (P1-27). In prod the info log is a no-op and the error path
  // routes to the sanctioned telemetry channel rather than console — keeping errors visible
  // without the verbose leak. Secret-handling rules still hold: secrets-bearing scopes
  // (wallet.ts, keyManager.ts) never log; the SDK's logs are about engine lifecycle, not keys.
  const debugLogging = import.meta.env.DEV
  setLoggers(
    debugLogging
      ? (msg: string) => {
          // eslint-disable-next-line no-console
          console.log('[railgun]', msg)
        }
      : () => {},
    debugLogging
      ? (err: Error) => {
          // eslint-disable-next-line no-console
          console.error('[railgun]', err)
        }
      : (err: Error) => {
          trackError('railgun.sdk', err)
        },
  )

  const db = createWebDatabase(ENGINE_DB_NAME)
  const artifactStore = await createBrowserArtifactStore()

  await startRailgunEngine(
    ENGINE_WALLET_SOURCE,
    db as never, // level-js export shape isn't typed; SDK accepts the leveldown-compatible API
    debugLogging, // shouldDebug — gated on DEV (P1-27)
    artifactStore,
    false, // useNativeArtifacts (false = WASM for browser)
    false, // skipMerkletreeScans (false = enable balance scanning)
    undefined, // poiNodeURLs (POI disabled; see POI.init below)
    undefined, // customPOILists
    debugLogging, // verboseScanLogging — gated on DEV (P1-27)
  )

  // Override the SDK's IPFS artifact pipeline with Armada's own circuits.
  // startRailgunEngine hardcodes artifactGetterDownloadJustInTime which downloads
  // from IPFS and validates against Railgun's hash manifest. overrideArtifact()
  // writes directly into the in-memory cache, bypassing both IPFS and hash checks.
  // In local mode we serve artifacts from armada-circuits/build/ via Vite middleware.
  // In sepolia mode, skip the override and let the SDK use IPFS.
  if (import.meta.env.VITE_NETWORK !== 'sepolia') {
    await loadArmadaCircuits(overrideArtifact)
  }

  // Wire SDK merkletree scan progress into syncStateAtom so the UI can show a banner +
  // progress bar during the initial historical scan. The SDK emits one of four statuses;
  // we map them to our SyncState shape. Progress is 0..1.
  const store = getDefaultStore()
  setOnUTXOMerkletreeScanCallback((event) => {
    const { scanStatus, progress } = event
    switch (scanStatus) {
      case MerkletreeScanStatus.Started:
        store.set(syncStateAtom, { status: 'syncing', progress: 0 })
        break
      case MerkletreeScanStatus.Updated:
        store.set(syncStateAtom, { status: 'syncing', progress: progress ?? 0 })
        break
      case MerkletreeScanStatus.Complete:
        store.set(syncStateAtom, { status: 'complete', progress: 1 })
        break
      case MerkletreeScanStatus.Incomplete:
        store.set(syncStateAtom, { status: 'failed', progress: progress ?? 0 })
        break
    }
  })

  // Wire snarkjs as the Groth16 prover implementation. Unshield / transfer proofs throw
  // "Requires groth16 full prover implementation" without this. Shield doesn't need it
  // (ECIES + Poseidon only), but we initialize unconditionally so the first unshield doesn't
  // pay the snarkjs import cost on the critical path.
  await initializeProver()

  // POI is required by the SDK for proof generation calls, but our deployment doesn't run a POI
  // node. Install a noop interface so isRequiredForChain() returns false without crashing.
  try {
    const dummyNodeInterface = {
      isActive: () => false,
      isRequired: async () => false,
      getPOIsPerList: async () => ({}),
      getPOIMerkleProofs: async () => ({}),
      validatePOIMerkleroots: async () => true,
      submitPOI: async () => {},
      submitLegacyTransactProofs: async () => {},
    }
    POI.init([], dummyNodeInterface as unknown as Parameters<typeof POI.init>[1])
  } catch {
    // Non-fatal — if POI.init fails the engine still runs for non-proof operations (balance
    // scan, address derivation). Proof-generating flows will surface the error at call time.
  }
}

export function isRailgunEngineInitialized(): boolean {
  return initialized
}

export function getRailgunInitError(): Error | null {
  return lastError
}

/** Reset module-scope init state — for hot-reload / test scenarios. */
export function resetInitState(): void {
  initialized = false
  inFlight = null
  lastError = null
  setEngineState('cold')
}

/** User-triggered retry after a failed engine warm-up (Sign step). */
export async function retryRailgunEngineInit(): Promise<void> {
  resetInitState()
  await initRailgunEngine()
}
