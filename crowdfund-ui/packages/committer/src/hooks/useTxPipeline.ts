// ABOUTME: App-level approve+commit pipeline engine — one in-flight pipeline per address, backed by a Jotai atom.
// ABOUTME: Survives modal close (re-attaches), pauses when detached so no wallet prompt fires with no UI, aborts on account switch.

import { useCallback, useEffect } from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import type { TransactionResponse } from 'ethers'
import type { ReceiptLogLike, Step4Transaction } from '@armada/crowdfund-shared'
import { sendAndWaitTx } from '@/lib/sendAndWaitTx'
import { savePendingTx, removePendingTx } from '@/lib/pendingTx'
import { getHubChainId, getExplorerUrl } from '@/config/network'

/** One transaction in a pipeline: a labelled wallet send plus optional follow-ups. */
export interface TxStep {
  label: string
  /** Issues the tx (pops the wallet prompt). */
  send: () => Promise<TransactionResponse>
  /** Receipt logs on success — e.g. ingest commit events into the graph store. */
  onReceipt?: (logs: readonly ReceiptLogLike[]) => void
  /** Side effect after this step confirms, before the next send (e.g. refresh allowance). */
  after?: () => Promise<void>
}

/**
 * idle → running ⇄ paused → success | error | aborted | rejected.
 * `paused` = detached mid-run (resumable); `aborted` = account switched (terminal);
 * `rejected` = user declined in the wallet (quiet — the flow returns to review).
 */
export type PipelinePhase =
  | 'idle'
  | 'running'
  | 'paused'
  | 'success'
  | 'error'
  | 'aborted'
  | 'rejected'

export interface PipelineState {
  rows: Step4Transaction[]
  phase: PipelinePhase
}

const IDLE_STATE: PipelineState = { rows: [], phase: 'idle' }

/** Per-address render state. Read by the flow component and the pending-tx chip. */
export const pipelinesAtom = atom<Record<string, PipelineState>>({})

// Engine state that is not render-relevant (closures, cursor, flags) lives outside
// the atom, keyed by address. One record per address ⇒ single-flight per address.
interface EngineRecord {
  steps: TxStep[]
  cursor: number
  attached: boolean
  running: boolean
  aborted: boolean
  onSuccess?: () => void | Promise<void>
}
const records = new Map<string, EngineRecord>()

type Store = ReturnType<typeof useStore>

function readState(store: Store, address: string): PipelineState {
  return store.get(pipelinesAtom)[address] ?? IDLE_STATE
}

function writeState(store: Store, address: string, next: PipelineState): void {
  store.set(pipelinesAtom, (prev) => ({ ...prev, [address]: next }))
}

function setPhase(store: Store, address: string, phase: PipelinePhase): void {
  writeState(store, address, { ...readState(store, address), phase })
}

function setRow(
  store: Store,
  address: string,
  index: number,
  patch: Partial<Step4Transaction>,
): void {
  const current = readState(store, address)
  const rows = current.rows.slice()
  rows[index] = { ...rows[index], ...patch }
  writeState(store, address, { ...current, rows })
}

function initialRows(steps: TxStep[]): Step4Transaction[] {
  return steps.map((s) => ({ label: s.label, status: 'pending' }))
}

// The pipeline loop. Detached (not awaited) so it survives the component unmount.
// Re-entrant: pause/resume re-invokes it; the `running` guard keeps it single-flight.
async function drive(store: Store, address: string): Promise<void> {
  const rec = records.get(address)
  if (!rec || rec.running) return
  rec.running = true
  try {
    while (rec.cursor < rec.steps.length) {
      // Decision point before each send — never prompt the wallet without UI.
      if (rec.aborted) {
        setPhase(store, address, 'aborted')
        return
      }
      if (!rec.attached) {
        setPhase(store, address, 'paused')
        return
      }
      const i = rec.cursor
      const step = rec.steps[i]
      // Phase 1: waiting for the wallet to confirm (no hash yet).
      setRow(store, address, i, {
        label: step.label,
        status: 'loading',
        phaseLabel: 'Confirm in your wallet…',
        errorMessage: undefined,
        errorDetails: undefined,
      })
      setPhase(store, address, 'running')

      const result = await sendAndWaitTx(step.send, (hash) => {
        // Phase 2: broadcast — show the explorer link and persist for resume-watch.
        setRow(store, address, i, {
          phaseLabel: 'Submitting…',
          hash,
          explorerUrl: getExplorerUrl(),
        })
        savePendingTx({
          chainId: getHubChainId(),
          address,
          txHash: hash,
          label: step.label,
          sentAt: Date.now(),
        })
      })
      // A resolved tx no longer needs watching; a timed-out one may still
      // confirm, so it stays persisted for the post-timeout watcher (3.4).
      if (result.hash && result.outcome !== 'timeout') {
        removePendingTx(result.hash)
      }
      if (result.outcome === 'success') {
        setRow(store, address, i, { status: 'done', phaseLabel: undefined })
        step.onReceipt?.(result.logs ?? [])
        if (step.after) await step.after()
        rec.cursor = i + 1
        continue
      }

      if (result.outcome === 'rejected') {
        // The user intentionally declined — don't render a red error. Revert the
        // row to pending and let the flow return to review (quiet rejection).
        setRow(store, address, i, {
          status: 'pending',
          phaseLabel: undefined,
          hash: undefined,
          explorerUrl: undefined,
        })
        setPhase(store, address, 'rejected')
        return
      }

      // reverted / timeout / error — stop at this row with an error.
      setRow(store, address, i, {
        status: 'error',
        phaseLabel: undefined,
        errorMessage: result.errorMessage,
        errorDetails: result.errorDetails,
      })
      setPhase(store, address, 'error')
      return
    }
    setPhase(store, address, 'success')
    await rec.onSuccess?.()
  } finally {
    rec.running = false
  }
}

export interface RunTxPipelineParams {
  address: string
  steps: TxStep[]
  onSuccess?: () => void | Promise<void>
}

/** Start a pipeline for `address`. No-op if one is already running or paused (single-flight). */
export function runTxPipeline(store: Store, params: RunTxPipelineParams): void {
  const { address, steps, onSuccess } = params
  const existing = records.get(address)
  const phase = readState(store, address).phase
  if (existing && (existing.running || phase === 'running' || phase === 'paused')) return

  records.set(address, {
    steps,
    cursor: 0,
    attached: true,
    running: false,
    aborted: false,
    onSuccess,
  })
  writeState(store, address, { rows: initialRows(steps), phase: 'running' })
  void drive(store, address)
}

/**
 * Mark whether a flow component is currently showing this address's pipeline.
 * Detaching mid-run lets the engine pause before the next send; re-attaching a
 * paused pipeline resumes it.
 */
export function setPipelineAttached(store: Store, address: string, attached: boolean): void {
  const rec = records.get(address)
  if (!rec) {
    // Attach state recorded before any run() — keep it for when the run starts.
    records.set(address, {
      steps: [],
      cursor: 0,
      attached,
      running: false,
      aborted: false,
    })
    return
  }
  rec.attached = attached
  if (attached && !rec.running && readState(store, address).phase === 'paused') {
    void drive(store, address)
  }
}

/**
 * Abort any running/paused pipeline that is NOT for `liveAddress` (the wallet
 * switched accounts). The in-flight tx is left to settle; no further sends fire.
 */
export function abortPipelinesForOtherAddress(store: Store, liveAddress: string | null): void {
  for (const [address, rec] of records) {
    if (address === liveAddress) continue
    const phase = readState(store, address).phase
    if (phase !== 'running' && phase !== 'paused') continue
    rec.aborted = true
    // A paused pipeline has no active loop to notice the flag — flip it now.
    if (!rec.running) setPhase(store, address, 'aborted')
  }
}

/**
 * Re-attempt a pipeline that stopped on an error, resuming from the failed row
 * (earlier successes are kept — no re-sends). No-op unless the pipeline is in
 * the `error` phase.
 */
export function retryTxPipeline(store: Store, address: string): void {
  const rec = records.get(address)
  if (!rec || rec.running) return
  if (readState(store, address).phase !== 'error') return
  rec.aborted = false
  rec.attached = true
  setRow(store, address, rec.cursor, {
    status: 'loading',
    errorMessage: undefined,
    errorDetails: undefined,
  })
  setPhase(store, address, 'running')
  void drive(store, address)
}

/**
 * Apply a background watcher's resolution of a tx (identified by hash) to the
 * pipeline row it belongs to. Used by the post-timeout watcher: a row left in
 * the "still pending" error state flips to done (or reverted) once the tx lands.
 * On confirmation, if every row is now done the pipeline completes (`success`).
 */
export function applyWatchedTxResult(
  store: Store,
  txHash: string,
  outcome: 'confirmed' | 'reverted',
): void {
  const all = store.get(pipelinesAtom)
  for (const address of Object.keys(all)) {
    const idx = all[address].rows.findIndex((r) => r.hash === txHash)
    if (idx === -1) continue
    if (outcome === 'confirmed') {
      setRow(store, address, idx, {
        status: 'done',
        phaseLabel: undefined,
        errorMessage: undefined,
        errorDetails: undefined,
      })
      if (readState(store, address).rows.every((r) => r.status === 'done')) {
        setPhase(store, address, 'success')
      }
    } else {
      setRow(store, address, idx, {
        status: 'error',
        phaseLabel: undefined,
        errorMessage: 'Transaction reverted',
      })
      setPhase(store, address, 'error')
    }
    return
  }
}

/** Clear a single address's pipeline back to idle (e.g. after the user dismisses it). */
export function resetTxPipeline(store: Store, address: string): void {
  records.delete(address)
  store.set(pipelinesAtom, (prev) => {
    if (!(address in prev)) return prev
    const next = { ...prev }
    delete next[address]
    return next
  })
}

/** Drop all pipeline engine state (e.g. on full wallet disconnect, or test teardown). */
export function clearAllPipelines(): void {
  records.clear()
}

export function getPipelineState(store: Store, address: string | null): PipelineState {
  if (!address) return IDLE_STATE
  return readState(store, address)
}

export interface UseTxPipelineResult {
  state: PipelineState
  run: (steps: TxStep[], opts?: { onSuccess?: () => void | Promise<void> }) => void
  retry: () => void
  reset: () => void
}

/**
 * Bind a flow component to its address's pipeline. Mounting attaches (so a
 * paused pipeline resumes); unmounting detaches (so the engine pauses before the
 * next send). Returns the live render state plus run/reset controls.
 */
export function useTxPipeline(address: string | null): UseTxPipelineResult {
  const store = useStore()
  const all = useAtomValue(pipelinesAtom)
  const state = (address && all[address]) || IDLE_STATE

  useEffect(() => {
    if (!address) return
    setPipelineAttached(store, address, true)
    return () => setPipelineAttached(store, address, false)
  }, [store, address])

  const run = useCallback(
    (steps: TxStep[], opts?: { onSuccess?: () => void | Promise<void> }) => {
      if (!address) return
      runTxPipeline(store, { address, steps, onSuccess: opts?.onSuccess })
    },
    [store, address],
  )

  const retry = useCallback(() => {
    if (address) retryTxPipeline(store, address)
  }, [store, address])

  const reset = useCallback(() => {
    if (address) resetTxPipeline(store, address)
  }, [store, address])

  return { state, run, retry, reset }
}
