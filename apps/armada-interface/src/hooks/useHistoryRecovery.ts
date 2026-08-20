// ABOUTME: Drives chain-driven history recovery on wallet unlock — reconstructs history from the @armada/sdk scan, maps entries to TxRecord, persists via the existing OCC-protected storage, and advances a per-wallet checkpoint so subsequent scans only walk the delta.
// ABOUTME: Mount once at App root. Idempotent across re-mounts (effect re-runs only on walletId / epoch change). Shares the scan path with useIncomingTransferDetector (Phase 9.4) via lib/shielded/history.ts::runHistoryScan.

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import {
  historyRecoveryAtom,
  historyRecoveryTriggerAtom,
  type HistoryRecoveryStatus,
} from '@/state/history'
import { txListAtom, upsertTxAtom } from '@/state/tx'
import { putTxIfFresh } from '@/lib/tx/storage'
import { markRecoveredComplete, sourceHashProvesComplete } from '@/lib/tx/reducer'
import {
  runHistoryScan,
  type HistoryMapContext,
} from '@/lib/shielded/history'
import {
  readHistoryCheckpoint,
  writeHistoryCheckpoint,
} from '@/lib/shielded/history-checkpoint'
import { loadDeployments } from '@/config/deployments'
import { track, trackError } from '@/lib/telemetry'

/**
 * Run a history scan for the active wallet and persist new records. Wraps the pure
 * `runHistoryScan` with the IDB + atom + checkpoint side effects.
 *
 * Cancellation: the caller passes a getter for an `isCancelled` flag flipped on cleanup. The
 * scan itself can't be aborted (SDK doesn't expose a cancel), but post-scan writes check the
 * flag so a flipped wallet / unmount doesn't leak records into the wrong session.
 */
async function runScanAndPersist(args: {
  walletId: string
  ctx: HistoryMapContext
  fromBlock: number | undefined
  isCancelled: () => boolean
  /** Live lookup of the active wallet's record carrying a given (lowercased) `sourceTxHash`, if
   *  any. Reads from the store at call time (not a kickoff snapshot) so the reconcile upgrade
   *  builds on the latest `updatedSeq` and clears OCC. */
  findExistingByHash: (hash: string) => import('@/lib/tx/types').TxRecord | undefined
  upsert: (record: import('@/lib/tx/types').TxRecord) => void
  setStatus: (status: HistoryRecoveryStatus) => void
}): Promise<void> {
  const { walletId, ctx, fromBlock, isCancelled, findExistingByHash, upsert, setStatus } = args
  const start = performance.now()
  track('tx.history.scan.started', {
    walletId,
    fromBlock: fromBlock ?? null,
  })

  const result = await runHistoryScan(walletId, ctx, fromBlock)
  if (isCancelled()) return

  // putTxIfFresh's OCC math (existing.updatedSeq >= incoming.updatedSeq → reject) means
  // re-running the scan over the same items is a no-op at the storage layer. We still bump
  // the atom unconditionally so a recovered record that wasn't yet hydrated by useTxHistory
  // appears in the activity feed immediately. The atom's own OCC (upsertTxAtom) handles
  // dedup symmetrically.
  let written = 0
  for (const record of result.records) {
    if (isCancelled()) return
    // Reconcile-or-insert against any existing record carrying this on-chain hash:
    //   - already `completed` → skip. The authored record's lifecycle (kind-specific stages, real
    //     fee breakdown, signer EVM) is strictly richer than the synth row; don't clobber it.
    //   - non-terminal-but-confirmed (`expired`/`failed`/`cancelled`/mid-flight) → upgrade it in
    //     place to `completed` rather than skipping (which leaves a permanent false "expired" for
    //     a tx that actually landed) or inserting a duplicate `synth:` row beside it. (P1-24)
    const sourceHash = record.artifacts.sourceTxHash?.toLowerCase()
    if (sourceHash) {
      const existing = findExistingByHash(sourceHash)
      if (existing) {
        if (existing.executionState === 'completed') continue
        // T-H1: for a cross-chain kind the matched `sourceTxHash` is only the burn leg — CCTP
        // delivery on the destination chain hasn't happened (and may never). Don't force-complete;
        // leave the executor's delivery watcher authoritative. Without this, a hub burn surfacing
        // in shielded history paints a false "Funds delivered" and upgrades a real POLL_TIMEOUT
        // failure to permanent false success.
        if (!sourceHashProvesComplete(existing.kind)) continue
        const upgraded = markRecoveredComplete(existing)
        try {
          const fresh = await putTxIfFresh(upgraded)
          if (fresh) {
            upsert(upgraded)
            written += 1
          }
        } catch (err) {
          trackError('history.scan.reconcile', err, {
            scope: 'history.recovery',
            message: `failed to reconcile record ${existing.id} from chain`,
          })
        }
        continue
      }
    }
    try {
      const fresh = await putTxIfFresh(record)
      if (fresh) {
        upsert(record)
        written += 1
      }
    } catch (err) {
      // Don't abort the whole scan on one bad write — log and continue. A locked-wallet write
      // (e.g. auto-lock fired mid-scan) throws synchronously; subsequent loop iterations will
      // throw too, but the cancellation guard above catches the lock signal one tick later.
      trackError('history.scan.persist', err, {
        scope: 'history.recovery',
        message: `failed to persist synthesized record ${record.id}`,
      })
    }
  }

  if (result.highestBlock !== null) {
    writeHistoryCheckpoint(walletId, {
      block: result.highestBlock,
      scannedAt: Date.now(),
    })
  }

  track('tx.history.scan.completed', {
    walletId,
    itemCount: result.itemCount,
    recordCount: written,
    durationMs: Math.round(performance.now() - start),
  })

  if (!isCancelled()) {
    setStatus({ state: 'idle', lastRecordCount: written })
  }
}

/**
 * Resolve the mapping context (hub chain id) from the deployment manifest. Returns null if the
 * hub manifest can't be loaded — without it we don't know the chain id to stamp on records.
 *
 * `hub.deployBlock` is the floor for the SDK's `startingBlock` when no checkpoint exists. The
 * SDK falls back to block 0 if undefined, which on Sepolia means thousands of empty getLogs
 * calls walking pre-deploy history — never worth it.
 */
async function resolveScanInputs(): Promise<{
  ctx: HistoryMapContext
  hubDeployBlock: number | undefined
} | null> {
  try {
    const deployments = await loadDeployments()
    return {
      ctx: {
        hubChainId: deployments.hub.chainId,
      },
      hubDeployBlock: deployments.hub.deployBlock,
    }
  } catch (err) {
    trackError('history.scan.inputs', err, {
      scope: 'history.recovery',
      message: 'failed to resolve scan inputs',
    })
    return null
  }
}

/**
 * Mount once at App root. Runs a one-time scan whenever a wallet unlocks, plus an additional
 * scan whenever `historyRecoveryTriggerAtom` bumps (Settings → Re-scan history, banner Retry,
 * Clear history, and the incoming-transfer detector). Idempotent within a session: a re-render of
 * App.tsx doesn't trigger a duplicate scan because the `lastRunRef` guard skips the effect body
 * when the same walletId+trigger.id ran already.
 *
 * Banner visibility: the recovery banner is surfaced only for the initial recovery on unlock and
 * for user-initiated re-scans (`trigger.silent === false`). Routine incremental delta scans from
 * the incoming-transfer detector (`silent: true`) run without flipping to `scanning`, so a tx
 * completing or a received transfer doesn't flash the banner on the dashboard.
 */
export function useHistoryRecovery(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const trigger = useAtomValue(historyRecoveryTriggerAtom)
  const setStatus = useSetAtom(historyRecoveryAtom)
  const upsert = useSetAtom(upsertTxAtom)
  const store = useStore()
  // Tracks the most recent (walletId, epoch) pair we kicked a scan for. Guards against
  // duplicate runs inside the same session (e.g. StrictMode double-mount in dev).
  const lastRunRef = useRef<string | null>(null)

  useEffect(() => {
    if (active?.status !== 'unlocked') {
      // Drop the running status when the wallet locks mid-scan; the in-flight scan's own
      // cancellation guard will swallow the rest.
      lastRunRef.current = null
      setStatus({ state: 'idle' })
      return
    }
    const walletId = active.id
    const runKey = `${walletId}:${trigger.id}`
    if (lastRunRef.current === runKey) return
    // A run is "visible" (surfaces the recovery banner) when it's the initial recovery on unlock
    // (`lastRunRef` is null = first run this unlocked session — always visible, even if the trigger's
    // last `silent` value is stale-true from a prior session) OR a user-initiated re-scan
    // (`!trigger.silent`). A run triggered only by the incoming-transfer detector (`silent: true`)
    // runs silently so it doesn't flash the banner after every balance change.
    const visible = lastRunRef.current === null || !trigger.silent
    lastRunRef.current = runKey

    let cancelled = false
    const isCancelled = () => cancelled
    if (visible) setStatus({ state: 'scanning' })

    void (async () => {
      const inputs = await resolveScanInputs()
      if (cancelled) return
      if (!inputs) {
        // Couldn't resolve manifest — bail to idle. Better than failed since the user can
        // still use the app; the chain-recovered rows just won't show this session.
        setStatus({ state: 'idle' })
        return
      }
      const checkpoint = readHistoryCheckpoint(walletId)
      // `fromBlock = checkpoint.block + 1` (resume past last scanned) OR `hub.deployBlock`
      // (first-ever scan on this device) OR undefined (SDK defaults to genesis — slow but
      // not incorrect; falls through when neither hint is available).
      const fromBlock =
        checkpoint !== null
          ? checkpoint.block + 1
          : inputs.hubDeployBlock

      try {
        await runScanAndPersist({
          walletId,
          ctx: inputs.ctx,
          fromBlock,
          isCancelled,
          // Live lookup (not a kickoff snapshot) so the reconcile upgrade builds on the latest
          // updatedSeq and clears OCC. Lowercased on both sides so on-chain hex-case variance
          // can't bypass the match.
          // Match on sourceTxHash OR destTxHash (T-H2): a completed cross-chain shield stores the
          // hub MINT hash in destTxHash (sourceTxHash holds the client burn). The SDK surfaces the
          // hub mint as a Shield history item; matching only sourceTxHash misses the authored
          // record and synthesizes a second permanent "Deposit" row for the same funds.
          findExistingByHash: (hash) =>
            store.get(txListAtom).find(
              r =>
                r.artifacts.sourceTxHash?.toLowerCase() === hash ||
                (r.artifacts as { destTxHash?: string }).destTxHash?.toLowerCase() === hash,
            ),
          upsert,
          setStatus,
        })
      } catch (err) {
        if (cancelled) return
        trackError('history.scan.failed', err, {
          scope: 'history.recovery',
          message: 'scan failed',
        })
        // A silent (incoming-transfer detector) scan failing is background noise — telemetry only,
        // no red banner. Visible scans surface the failure so the user can Retry.
        if (visible) {
          setStatus({
            state: 'failed',
            error: err instanceof Error ? err.message : 'Scan failed',
          })
        } else {
          setStatus({ state: 'idle' })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active?.id, active?.status, trigger, setStatus, upsert])
}
