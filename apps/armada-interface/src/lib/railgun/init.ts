// ABOUTME: Railgun engine bootstrap — RailgunEngine.initForWallet + setEngine + POI dummy + our own ArtifactGetter. Drives railgunEngineAtom through cold → warming → ready / failed.
// ABOUTME: Idempotent; safe to call multiple times. Engine loads the WASM proving stack (~1 MB) lazily, so we keep init off the critical path until the user needs it.

// The Railgun SDK + its transitive deps (circomlibjs, ethereum-cryptography) crash on
// module-load under jsdom. We `import()` at call time so test files that transitively pull
// in this module don't blow up before any user code runs. Production cost: one extra microtask
// the first time initRailgunEngine() runs.
import { getDefaultStore } from 'jotai'
// Type-only imports — erased at compile time (verbatimModuleSyntax), so they do NOT trigger the
// jsdom-crashing module-load the runtime `import()` calls below guard against.
import type { Artifact } from '@railgun-community/shared-models'
import type { UTXOScanDecryptBalancesCompleteEventData } from '@railgun-community/engine'
import { createWebDatabase } from './database'
import { armadaArtifactGetter, setArmadaArtifact } from './artifactGetter'
import { quickSyncEventsClient } from './quickSync'
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
 *   2. Create the level-js DB (IndexedDB-backed).
 *   3. Construct the engine via `RailgunEngine.initForWallet` + `setEngine`, injecting our own
 *      quick-sync source (the watcher client) and `ArtifactGetter`, then replicate the internal
 *      balance-complete listener the `startRailgunEngine` convenience would have wired.
 *   4. Install a dummy POI node interface so proof generation doesn't crash with
 *      "Cannot read properties of undefined (reading isRequired)" on local devnet where POI
 *      isn't configured.
 *
 * Armada circuit artifacts are registered with our getter separately: `loadArmadaCircuits` (DEV,
 * below) and `preloadArtifactsFromOrigin` (prod, artifacts.ts, called from App.tsx).
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
 * Load Armada circuit artifacts from the Vite dev server and register them with our own
 * ArtifactGetter (see artifactGetter.ts) via the `register` callback.
 *
 * In local mode, artifacts are served from armada-circuits/build/ via the
 * serveCircuitArtifacts() Vite middleware at /api/circuits/<N>x<M>/.
 *
 * Only loads the shapes registered on-chain (TESTING_ARTIFACT_CONFIGS).
 * Each shape's WASM (~4MB) + ZKEY (~13MB) are fetched once per session and held in the getter's
 * registry so the first proof doesn't pay a fetch penalty. Because we supply the getter to
 * initForWallet ourselves, these artifacts bypass the SDK's IPFS + hash-manifest path entirely.
 */

// The shapes registered on PrivacyPool during deployment
const ARMADA_SHAPES: Array<[number, number]> = [
  [1, 1], [1, 2], [2, 2], [2, 3], [8, 4],
  [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1],
  [3, 2], [4, 2], [5, 2], [6, 2],
  [1, 3], [3, 3], [4, 3],
]

async function loadArmadaCircuits(
  register: (variant: string, artifact: Artifact) => void,
): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[shielded] Loading Armada circuit artifacts...')

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
        console.warn(`[shielded] Skipping ${variant}: artifacts not available (WASM:${wasmRes.status} ZKEY:${zkeyRes.status})`)
        continue
      }

      const wasm = new Uint8Array(await wasmRes.arrayBuffer())
      const zkey = new Uint8Array(await zkeyRes.arrayBuffer())
      const vkey = await vkeyRes.json()

      // `dat` is the native-prover witness calculator; we use the snarkjs (wasm) path, so it's
      // unused. The SDK's Artifact type still requires the key — pass it explicitly as undefined.
      register(variant, { wasm, zkey, vkey, dat: undefined })
    } catch (err) {
      // Non-fatal — the SDK will fall back to IPFS for this shape
      // eslint-disable-next-line no-console
      console.warn(`[shielded] Failed to load ${variant}:`, err)
    }
  }

  // eslint-disable-next-line no-console
  console.log('[shielded] Armada circuit artifacts loaded')
}

async function doInit(): Promise<void> {
  const [
    { setEngine, setLoggers, setOnUTXOMerkletreeScanCallback, onBalancesUpdate },
    { RailgunEngine, POI, EngineEvent },
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
  // The engine subscribes to ALL events (`'*'`) on the PrivacyPool contract, then rejects any log
  // that isn't one of its four 1-topic events (Nullified/Shield/Transact/Unshield). Armada's pool
  // emits additional events — some with indexed params, so >1 topic — at that same address, so every
  // successful pool tx trips one of these two guards. The engine catches + swallows them internally
  // (they never affect tree sync), but they still reach this error logger. Demote them so they don't
  // spam the console (DEV) or generate false-alarm Sentry events (prod). Genuine SDK errors still flow.
  const isBenignEngineEventNoise = (err: Error): boolean =>
    err.message === 'Requires one topic for railgun events' ||
    err.message === 'Event topic not recognized'

  const debugLogging = import.meta.env.DEV
  // Extracted so both the wallet-SDK logger surface (setLoggers) and the engine-level debugger
  // (initForWallet's engineDebugger arg) route through the same filtered sink — mirroring what the
  // startRailgunEngine convenience did internally via its non-exported createEngineDebugger.
  const sdkLog = debugLogging
    ? (msg: string) => {
        // eslint-disable-next-line no-console
        console.log('[shielded]', msg)
      }
    : () => {}
  const sdkError = debugLogging
    ? (err: Error) => {
        if (isBenignEngineEventNoise(err)) {
          // eslint-disable-next-line no-console
          console.debug('[shielded] (benign engine event noise)', err.message)
          return
        }
        // eslint-disable-next-line no-console
        console.error('[shielded]', err)
      }
    : (err: Error) => {
        if (isBenignEngineEventNoise(err)) return
        trackError('shielded.engine', err)
      }
  setLoggers(sdkLog, sdkError)

  const db = createWebDatabase(ENGINE_DB_NAME)

  // Quick-sync callback (initForWallet arg 4) — the relayer-v2 watcher client. It hydrates the
  // wallet's merkletree from our pre-indexed AccumulatedEvents instead of an O(chain-length) event
  // scan. When VITE_INDEXER_URL is unset it returns empty → the engine falls back to the slow
  // on-chain scan (B4), so this is safe to wire unconditionally. On-chain merkleroot validation
  // (WI-4) keeps a malicious/buggy watcher from ever forging balances.
  // POI / TXID-merkletree callbacks (args 5-7). POI is disabled in this deployment (see the dummy
  // node interface below), so these stay stubbed. NOTE: the arg-6 validator is the TXID (POI) tree
  // validator — a different concern from the UTXO merkleroot check that guards displayed balances
  // (WI-4). Do not wire on-chain rootHistory here.
  const quickSyncRailgunTransactionsV2Stub = async () => []
  const txidMerklerootValidatorStub = async () => true
  const getLatestValidatedRailgunTxidStub = async () => ({
    txidIndex: undefined,
    merkleroot: undefined,
  })

  // Engine-level verbose/error logging. Same sink as setLoggers above (see sdkLog/sdkError).
  const engineDebugger = { log: sdkLog, error: sdkError, verboseScanLogging: debugLogging }

  // Construct the engine ourselves (rather than via the startRailgunEngine convenience) so we can
  // supply our own quick-sync source (arg 4) and ArtifactGetter (arg 3 — the SDK's
  // download-just-in-time getter isn't exported). setEngine then registers this instance with the
  // wallet-SDK singleton, so every other convenience (wallet lifecycle, balances, provider
  // loading) keeps working unchanged against our engine.
  const engine = await RailgunEngine.initForWallet(
    ENGINE_WALLET_SOURCE,
    db as never, // level-js export shape isn't typed; SDK accepts the leveldown-compatible API
    armadaArtifactGetter,
    quickSyncEventsClient,
    quickSyncRailgunTransactionsV2Stub,
    txidMerklerootValidatorStub,
    getLatestValidatedRailgunTxidStub,
    engineDebugger,
    false, // skipMerkletreeScans (false = enable balance scanning)
  )
  setEngine(engine)

  // Replicate the internal balance-complete listener that startRailgunEngine wires but the
  // low-level initForWallet does not: on UTXOScanDecryptBalancesComplete, recompute each wallet's
  // balances (onBalancesUpdate drives setOnBalanceUpdateCallback in sync.ts) and emit scan-complete
  // (which our setOnUTXOMerkletreeScanCallback below maps to syncStateAtom → complete). Without
  // this, shielded balances never populate and the sync banner never clears. The building blocks
  // are exported even though the SDK's own wiring helper is not.
  engine.on(
    EngineEvent.UTXOScanDecryptBalancesComplete,
    (event: UTXOScanDecryptBalancesCompleteEventData) => {
      const { txidVersion, chain, walletIdFilter } = event
      void (async () => {
        let walletsToUpdate = Object.values(engine.wallets)
        if (walletIdFilter != null) {
          walletsToUpdate = walletsToUpdate.filter((wallet) => walletIdFilter.includes(wallet.id))
        }
        await Promise.all(walletsToUpdate.map((wallet) => onBalancesUpdate(txidVersion, wallet, chain)))
        engine.emitScanEventHistoryComplete(txidVersion, chain)
      })()
    },
  )

  // Register Armada's own circuits with our ArtifactGetter. Because we own the getter, these
  // bypass the SDK's IPFS + hash-manifest path entirely (the same effect overrideArtifact had, but
  // through our getter rather than the SDK's non-exported internal one). The serveCircuitArtifacts()
  // Vite dev middleware serves armada-circuits/build for ALL networks (local + sepolia), so gate on
  // DEV rather than network: any dev-server run gets Armada artifacts. Production builds skip this —
  // the static-artifact path for prod sepolia is tracked separately (F4/#408) and until it lands,
  // prod sepolia is not supported. (Prod's own preload — preloadArtifactsFromOrigin in artifacts.ts,
  // called from App.tsx — also feeds this same getter registry.)
  if (import.meta.env.DEV) {
    await loadArmadaCircuits(setArmadaArtifact)
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
