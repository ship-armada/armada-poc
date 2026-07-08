// ABOUTME: History-recovery UI state — surfaces "scanning chain" + error states from useHistoryRecovery (Phase 9.3) to AppLayout banner + History page empty-state copy.
// ABOUTME: historyRecoveryEpochAtom bumps when the user invokes "Re-scan history" so the hook re-fires its effect.

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

/**
 * Bumped by the Settings "Re-scan history" action (Phase 9.5). useHistoryRecovery includes
 * this in its effect deps so a bump re-runs the scan — including wiping the checkpoint so the
 * SDK walks from the hub deploy block.
 */
export const historyRecoveryEpochAtom = atom<number>(0)
