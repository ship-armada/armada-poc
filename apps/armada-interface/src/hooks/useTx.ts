// ABOUTME: Per-tx hook — submit a transaction, track its lifecycle, retry on failure. Multi-instance safe.
// ABOUTME: Each call generates a ulid; multiple calls = multiple concurrent tx records. Engine integration lands in Bundle 3 (executor).

import { useCallback, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ulid } from 'ulid'
import type { MetaFor, StageFor, TxKind, TxRecord, TxWalletContext } from '@/lib/tx/types'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import { putTxIfFresh } from '@/lib/tx/storage'
import { toast } from 'sonner'
import { cancelTx, executeTx, getIsLeader, retryTx } from '@/lib/tx/executor'
import { txByIdAtom, upsertTxAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom, evmAddressAtom } from '@/state/wallet'
import { getNetworkConfig } from '@/config/network'
import { track } from '@/lib/telemetry'

export interface UseTxOptions<K extends TxKind> {
  kind: K
}

export interface UseTxResult<K extends TxKind> {
  record: TxRecord<K> | undefined
  /**
   * Submit a new tx. Generates the id, persists the initial record, dispatches to the executor.
   * Returns the new record id, or `null` when this tab isn't the executor leader (a follower-tab
   * submit is refused — see below — so callers can keep the user on the review step).
   */
  submit: (meta: MetaFor<K>) => Promise<string | null>
  /**
   * Retry from a retryable stage via the executor's `retryTx` (marks the record `retrying` and
   * re-dispatches). Returns true if the retry was accepted, false if refused (no record or the
   * stage isn't retryable) so callers don't flip a modal to its progress step on a no-op.
   */
  retry: () => Promise<boolean>
  /** Cancel polling for this record. Does not roll back on-chain state. */
  cancel: () => void
}

export function useTx<K extends TxKind>(opts: UseTxOptions<K>): UseTxResult<K> {
  const [id, setId] = useState<string | null>(null)
  const upsert = useSetAtom(upsertTxAtom)
  const evmAddress = useAtomValue(evmAddressAtom)
  const activeWalletId = useAtomValue(activeRailgunWalletIdAtom)
  const record = useAtomValue(useMemo(() => txByIdAtom(id ?? ''), [id])) as TxRecord<K> | undefined

  const submit = useCallback(async (meta: MetaFor<K>): Promise<string | null> => {
    // Hard guard: every tx record must be scoped to the active opaque walletId so
    // `activeTxListAtom` and `loadTxsForWallet` can resolve it. Submitting without one
    // would orphan the record (invisible in History, RecentActivityCard, balance derivation)
    // and rejected at reload. Submit() can't be reached from the UI before unlock, but the
    // guard makes the invariant explicit.
    if (!activeWalletId) throw new Error('useTx.submit: no active shielded walletId')

    // Multi-tab honesty (P1-26): only the leader tab runs the executor (`executeTx` no-ops on a
    // follower). A follower-tab submit would persist a record that nothing ever drives — a
    // permanent "pending" that also blocks auto-lock. Refuse it here: tell the user where
    // execution lives, persist nothing, and return null so the modal stays on its review step.
    if (!getIsLeader()) {
      toast('Transactions run in your first Armada tab. Switch to it, or close it and reload this one.')
      return null
    }

    const lifecycle = lifecycleFor(opts.kind)
    const initialStage = lifecycle.stages[0] as StageFor<K>
    const newId = ulid()
    const now = Date.now()

    const walletContext: TxWalletContext = {
      evmAddress: evmAddress ?? undefined,
      railgunWalletId: activeWalletId,
      // TODO(per-kind): if the kind's meta carries a more specific source chain
      // (e.g. shield.fromChainId), feature passes should override this default.
      sourceChainId: getNetworkConfig().hub.chainId,
    }

    const initial: TxRecord<K> = {
      id: newId,
      kind: opts.kind,
      executionState: 'pending',
      stage: initialStage,
      stagesCompleted: [],
      updatedSeq: 0,
      createdAt: now,
      updatedAt: now,
      meta,
      artifacts: {},
      walletContext,
    }
    setId(newId)
    upsert(initial)
    await putTxIfFresh(initial)
    track('tx.submitted', { id: newId, kind: opts.kind })

    // Dispatch to the executor. No-op until a stage handler is registered
    // for this kind (feature passes do that at module load time).
    executeTx(newId)
    return newId
  }, [opts.kind, upsert, evmAddress, activeWalletId])

  const retry = useCallback(async (): Promise<boolean> => {
    if (!record) return false
    // Delegate to the executor's retryTx — it enforces canRetryTx + markRetrying so the chain
    // loop actually re-enters the stage (a bare executeTx on a `failed` record just breaks).
    return retryTx(record.id)
  }, [record])

  const cancel = useCallback(() => {
    if (!record) return
    cancelTx(record.id)
  }, [record])

  return { record, submit, retry, cancel }
}
