// ABOUTME: App-level approve+commit pipeline engine — one in-flight pipeline per address, backed by a Jotai atom.
// ABOUTME: Survives modal close (re-attaches), pauses when detached so no wallet prompt fires with no UI, aborts on account switch.

import { useCallback, useEffect } from 'react'
import { atom, useAtomValue, useStore } from 'jotai'
import type { TransactionResponse } from 'ethers'
import type { ReceiptLogLike, Step4Transaction } from '@armada/crowdfund-shared'
import { sendAndWaitTx } from '@/lib/sendAndWaitTx'
import { savePendingTx, removePendingTx, loadPendingTxs } from '@/lib/pendingTx'
import { TX_PENDING_MESSAGE } from '@/lib/txWait'
import { getHubChainId, getExplorerUrl } from '@/config/network'

/** One transaction in a pipeline: a labelled wallet send plus optional follow-ups. */
export interface TxStep {
  label: string
  /** Issues the tx (pops the wallet prompt). */
  send: () => Promise<TransactionResponse>
  /** Receipt logs on success — e.g. ingest commit events into the graph store.
   *  Skipped when a step is confirmed out-of-band by the pending-tx watcher (only
   *  the drive() path calls it) — must not be load-bearing for a later send. */
  onReceipt?: (logs: readonly ReceiptLogLike[]) => void
  /** Side effect after this step confirms, before the next send (e.g. refresh
   *  allowance). Like onReceipt, skipped on watcher-confirmed steps — must not
   *  gate the correctness of a later send. */
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

/**
 * Snapshot of the confirmation-screen values, captured when a pipeline starts.
 * A modal flow's "what did I just commit" state lives in component-local state
 * that is lost when the modal is closed and reopened — but the pipeline (and
 * this snapshot) survive in the store. On re-attach, the confirmation reads this
 * instead of the reset-to-zero local state, so a backgrounded-then-resumed
 * commit shows the right numbers.
 */
export interface PipelineConfirmation {
  amount: number
  estimatedArm: number
  isAdditionalCommit: boolean
  totalCommittedUsdc: number
  maxedOut?: boolean
}

export interface PipelineState {
  rows: Step4Transaction[]
  phase: PipelinePhase
  /** Confirmation snapshot captured at run() time (see PipelineConfirmation). */
  confirmation?: PipelineConfirmation
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
      // Skip any row already completed out-of-band (e.g. confirmed by the
      // background watcher while this step sat timed-out). Keeps the cursor
      // self-healing so a resumed/retried pipeline never re-sends — or stomps —
      // a done row, independent of the watcher's remove/resolve ordering.
      if (readState(store, address).rows[rec.cursor]?.status === 'done') {
        rec.cursor += 1
        continue
      }
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

      // Idempotency guard: if a prior attempt already broadcast this step and
      // that tx is still unresolved (persisted pending), do NOT broadcast a
      // duplicate. The contract accepts over-cap commits, so a second commit on
      // a fresh nonce would pull USDC twice. The pending-tx watcher owns resolving
      // this hash and resumes the pipeline via applyWatchedTxResult once it lands.
      // TODO: recovering a genuinely dropped/replaced tx needs same-nonce,
      // gas-bumped resubmission — until then, in-tab recovery is a page reload (a
      // fresh flow's rows carry no hash, so the guard can't block it) or speeding
      // up / cancelling the tx in the wallet.
      const existingRow = readState(store, address).rows[i]
      if (existingRow?.hash && loadPendingTxs().some((t) => t.txHash === existingRow.hash)) {
        setRow(store, address, i, {
          status: 'error',
          phaseLabel: undefined,
          hash: existingRow.hash,
          explorerUrl: getExplorerUrl(),
          errorMessage: TX_PENDING_MESSAGE,
          errorDetails: `Transaction hash: ${existingRow.hash}`,
        })
        setPhase(store, address, 'error')
        return
      }

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
      // A tx that definitively resolved no longer needs watching: `success` is
      // done, and `reverted` changed no state (safe to re-send on retry). A
      // `timeout` or `error` with a broadcast hash may still be in the mempool —
      // keep it persisted so the post-timeout watcher resolves it AND the
      // idempotency guard above blocks a duplicate re-send until it does.
      if (result.hash && (result.outcome === 'success' || result.outcome === 'reverted')) {
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
  /** Confirmation snapshot to surface if the flow re-attaches after a close. */
  confirmation?: PipelineConfirmation
}

/** Start a pipeline for `address`. No-op if one is already running or paused (single-flight). */
export function runTxPipeline(store: Store, params: RunTxPipelineParams): void {
  const { address, steps, onSuccess, confirmation } = params
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
  writeState(store, address, { rows: initialRows(steps), phase: 'running', confirmation })
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
  // Don't pre-set the cursor row here: drive() skips any watcher-confirmed `done`
  // row (so retry never stomps it), sets the target row to `loading` on the send
  // path, or restores an actionable `error` row if the idempotency guard fires.
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
      // Reconcile the engine cursor so a resumed/retried pipeline continues past
      // this row instead of re-sending it. The record may be gone (a reset /
      // account-switch abort / clear raced this resolution) — null-guard it; the
      // row mutation above is render-only and safe without a record.
      const rec = records.get(address)
      if (rec && rec.cursor <= idx) rec.cursor = idx + 1
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
  run: (
    steps: TxStep[],
    opts?: { onSuccess?: () => void | Promise<void>; confirmation?: PipelineConfirmation },
  ) => void
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
    (
      steps: TxStep[],
      opts?: { onSuccess?: () => void | Promise<void>; confirmation?: PipelineConfirmation },
    ) => {
      if (!address) return
      runTxPipeline(store, {
        address,
        steps,
        onSuccess: opts?.onSuccess,
        confirmation: opts?.confirmation,
      })
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
