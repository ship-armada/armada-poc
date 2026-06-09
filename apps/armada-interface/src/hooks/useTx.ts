// ABOUTME: Per-tx hook — submit a transaction, track its lifecycle, retry on failure. Multi-instance safe.
// ABOUTME: Each call generates a ulid; multiple calls = multiple concurrent tx records. Engine integration lands in Bundle 3 (executor).

import { useCallback, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ulid } from 'ulid'
import type { MetaFor, StageFor, TxKind, TxRecord, TxWalletContext } from '@/lib/tx/types'
import { lifecycleFor } from '@/lib/tx/lifecycles'
import { putTxIfFresh } from '@/lib/tx/storage'
import { cancelTx, executeTx } from '@/lib/tx/executor'
import { txByIdAtom, upsertTxAtom } from '@/state/tx'
import { activeRailgunWalletIdAtom, evmAddressAtom } from '@/state/wallet'
import { getNetworkConfig } from '@/config/network'
import { track } from '@/lib/telemetry'

export interface UseTxOptions<K extends TxKind> {
  kind: K
}

export interface UseTxResult<K extends TxKind> {
  record: TxRecord<K> | undefined
  /** Submit a new tx. Generates the id, persists the initial record, dispatches to the executor (Bundle 3). */
  submit: (meta: MetaFor<K>) => Promise<string>
  /** Retry from a retryable stage. Dispatches the executor again with the existing record id. */
  retry: () => Promise<void>
  /** Cancel polling for this record. Does not roll back on-chain state. */
  cancel: () => void
}

export function useTx<K extends TxKind>(opts: UseTxOptions<K>): UseTxResult<K> {
  const [id, setId] = useState<string | null>(null)
  const upsert = useSetAtom(upsertTxAtom)
  const evmAddress = useAtomValue(evmAddressAtom)
  const activeWalletId = useAtomValue(activeRailgunWalletIdAtom)
  const record = useAtomValue(useMemo(() => txByIdAtom(id ?? ''), [id])) as TxRecord<K> | undefined

  const submit = useCallback(async (meta: MetaFor<K>) => {
    // Hard guard: every tx record must be scoped to the active opaque walletId so
    // `activeTxListAtom` and `loadTxsForWallet` can resolve it. Submitting without one
    // would orphan the record (invisible in History, RecentActivityCard, balance derivation)
    // and rejected at reload. Submit() can't be reached from the UI before unlock, but the
    // guard makes the invariant explicit.
    if (!activeWalletId) throw new Error('useTx.submit: no active shielded walletId')

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

  const retry = useCallback(async () => {
    if (!record) throw new Error('useTx.retry: no record')
    // Re-dispatch — the engine picks up from the current retryable stage.
    executeTx(record.id)
  }, [record])

  const cancel = useCallback(() => {
    if (!record) return
    cancelTx(record.id)
  }, [record])

  return { record, submit, retry, cancel }
}
