// ABOUTME: History-recovery UI state — surfaces "scanning chain" + error states from useHistoryRecovery (Phase 9.3) to AppLayout banner + History page empty-state copy.
// ABOUTME: historyRecoveryTriggerAtom bumps to re-fire the scan; its `silent` flag decides whether the recovery banner shows.

import { atom } from 'jotai'

export type HistoryRecoveryState = 'idle' | 'scanning' | 'failed'

export interface HistoryRecoveryStatus {
  state: HistoryRecoveryState
  /** Last-error message; only meaningful when `state === 'failed'`. */
  error?: string
  /** Total records the most-recent scan recovered (for telemetry / Settings affordances). */
  lastRecordCount?: number
}

/**
 * Live recovery status. Read by `<HistoryRecoveryBanner>` (Phase 9.5) and by the History page
 * empty-state copy. Written only by `useHistoryRecovery` + the incoming-transfer detector.
 */
export const historyRecoveryAtom = atom<HistoryRecoveryStatus>({ state: 'idle' })

/** Trigger for a recovery scan. `id` bumps to re-fire; `silent` controls banner visibility. */
export interface HistoryRecoveryTrigger {
  /** Monotonic counter — bumping it re-runs `useHistoryRecovery`'s scan. */
  id: number
  /**
   * When true, the scan runs WITHOUT surfacing the recovery banner — used for routine incremental
   * delta scans (the incoming-transfer detector fires one after every balance change). User-initiated
   * scans (Settings "Re-scan history", banner Retry, Clear history) bump with `silent: false` so the
   * banner shows. The initial recovery on unlock is always visible regardless of this flag.
   */
  silent: boolean
}

/**
 * Bumped to re-run the recovery scan. `useHistoryRecovery` includes this in its effect deps so a
 * bump re-fires the scan; its `silent` flag decides whether the `HistoryRecoveryBanner` appears.
 * User-initiated re-scans (Settings, Retry, Clear history) also wipe the checkpoint so the SDK
 * walks from the hub deploy block.
 */
export const historyRecoveryTriggerAtom = atom<HistoryRecoveryTrigger>({ id: 0, silent: false })
