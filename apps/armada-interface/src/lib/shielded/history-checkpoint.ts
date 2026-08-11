// ABOUTME: Per-wallet history-scan checkpoint stored in localStorage so subsequent unlocks only fetch the SDK delta instead of rewalking chain history from the hub deploy block every time.
// ABOUTME: Schema: `armada.shielded.historyScanBlock.<walletId>` → JSON `{ block: number, scannedAt: number }`. Reset via clearHistoryCheckpoint() when the user invokes "Re-scan history".

import { trackError } from '@/lib/telemetry'

const KEY_PREFIX = 'armada.shielded.historyScanBlock.'

export interface HistoryCheckpoint {
  /** Highest hub block number processed by the previous scan. Resume from `block + 1`. */
  block: number
  /** Wall-clock ms at write time. Surfaced to UI for "Last scanned X ago" affordances. */
  scannedAt: number
}

function keyFor(walletId: string): string {
  return `${KEY_PREFIX}${walletId}`
}

/**
 * Read the checkpoint for a wallet. Returns null when:
 *  - No checkpoint exists (first scan ever on this device for this wallet).
 *  - The stored value is corrupt (parse/shape failure) — treated as "no checkpoint" so the
 *    next scan starts from scratch rather than crashing.
 */
export function readHistoryCheckpoint(walletId: string): HistoryCheckpoint | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(keyFor(walletId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object'
      && parsed !== null
      && 'block' in parsed
      && typeof (parsed as { block: unknown }).block === 'number'
      && 'scannedAt' in parsed
      && typeof (parsed as { scannedAt: unknown }).scannedAt === 'number'
    ) {
      return parsed as HistoryCheckpoint
    }
    return null
  } catch (err) {
    trackError('history.checkpoint.read', err, {
      scope: 'history.checkpoint',
      message: 'failed to read checkpoint',
    })
    return null
  }
}

/**
 * Persist a new checkpoint. Idempotent; callers always overwrite with the latest highest-block
 * observed during a scan. A corrupt write surfaces as a tracked error but never throws — the
 * scan still succeeds, we just lose the resume hint and the next scan walks more chain history.
 */
export function writeHistoryCheckpoint(
  walletId: string,
  checkpoint: HistoryCheckpoint,
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(keyFor(walletId), JSON.stringify(checkpoint))
  } catch (err) {
    trackError('history.checkpoint.write', err, {
      scope: 'history.checkpoint',
      message: 'failed to write checkpoint',
    })
  }
}

/**
 * Wipe the checkpoint so the next scan walks from the hub deploy block. Wired to the Settings
 * "Re-scan history" action; also called by `useShieldedWallet.reset()` so a reset wallet doesn't
 * leave stale checkpoints in localStorage.
 */
export function clearHistoryCheckpoint(walletId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(keyFor(walletId))
  } catch (err) {
    trackError('history.checkpoint.clear', err, {
      scope: 'history.checkpoint',
      message: 'failed to clear checkpoint',
    })
  }
}
