// ABOUTME: Drives chain-driven history recovery on wallet unlock — calls the SDK's getWalletTransactionHistory, maps items to TxRecord, persists via the existing OCC-protected storage, and advances a per-wallet checkpoint so subsequent scans only walk the delta.
// ABOUTME: Mount once at App root. Idempotent across re-mounts (effect re-runs only on walletId / epoch change). Shares the scan path with useIncomingTransferDetector (Phase 9.4) via lib/railgun/history.ts::runHistoryScan.

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import {
  historyRecoveryAtom,
  historyRecoveryEpochAtom,
  type HistoryRecoveryStatus,
} from '@/state/history'
import { upsertTxAtom } from '@/state/tx'
import { putTxIfFresh } from '@/lib/tx/storage'
import {
  runHistoryScan,
  type HistoryMapContext,
} from '@/lib/railgun/history'
import {
  readHistoryCheckpoint,
  writeHistoryCheckpoint,
} from '@/lib/railgun/history-checkpoint'
import { loadDeployments, loadYieldDeployment } from '@/config/deployments'
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
  upsert: (record: import('@/lib/tx/types').TxRecord) => void
  setStatus: (status: HistoryRecoveryStatus) => void
}): Promise<void> {
  const { walletId, ctx, fromBlock, isCancelled, upsert, setStatus } = args
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
 * Resolve the mapping context (hub chain id + adapter address) from the deployment manifests.
 * Returns null if the hub manifest can't be loaded — without it we don't know the chain id
 * to stamp on records.
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
    const [deployments, yieldDeployment] = await Promise.all([
      loadDeployments(),
      loadYieldDeployment(),
    ])
    return {
      ctx: {
        hubChainId: deployments.hub.chainId,
        adapterAddress: yieldDeployment?.contracts.armadaYieldAdapter,
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
 * scan whenever `historyRecoveryEpochAtom` bumps (Settings → Re-scan history). Idempotent
 * within a session: a re-render of App.tsx doesn't trigger a duplicate scan because the
 * `runOnceRef` guard skips the effect body when the same walletId+epoch ran already.
 */
export function useHistoryRecovery(): void {
  const active = useAtomValue(activeShieldedWalletAtom)
  const epoch = useAtomValue(historyRecoveryEpochAtom)
  const setStatus = useSetAtom(historyRecoveryAtom)
  const upsert = useSetAtom(upsertTxAtom)
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
    const runKey = `${walletId}:${epoch}`
    if (lastRunRef.current === runKey) return
    lastRunRef.current = runKey

    let cancelled = false
    const isCancelled = () => cancelled
    setStatus({ state: 'scanning' })

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
          upsert,
          setStatus,
        })
      } catch (err) {
        if (cancelled) return
        trackError('history.scan.failed', err, {
          scope: 'history.recovery',
          message: 'scan failed',
        })
        setStatus({
          state: 'failed',
          error: err instanceof Error ? err.message : 'Scan failed',
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active?.id, active?.status, epoch, setStatus, upsert])
}
