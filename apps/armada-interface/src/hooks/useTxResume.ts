// ABOUTME: On unlock (leader tab only), resumes persisted non-terminal tx records for the active wallet — re-attaching watchers to already-broadcast txs and failing pre-broadcast interruptions honestly.
// ABOUTME: Mirrors useTxHistory's (walletId, status) reactivity; resumeForWallet is idempotent per (walletId, session) so a re-render or lock/unlock cycle can't double-dispatch.

import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { activeShieldedWalletAtom } from '@/state/wallet'
import { getIsLeader, resumeForWallet } from '@/lib/tx/executor'
import { trackError } from '@/lib/telemetry'

export function useTxResume() {
  const active = useAtomValue(activeShieldedWalletAtom)
  const activeWalletId = active?.id ?? null
  const activeStatus = active?.status ?? null

  useEffect(() => {
    // Resume needs the decryption key (loadAllTx decrypts AES-GCM envelopes), so it can only run
    // once the wallet is unlocked. Only the leader tab executes handlers — a follower resuming
    // would no-op in executeTx anyway, but we gate explicitly so a follower doesn't terminalize
    // records out from under the leader.
    if (!activeWalletId || activeStatus !== 'unlocked') return
    if (!getIsLeader()) return
    void resumeForWallet(activeWalletId).catch(err => trackError('useTxResume', err))
  }, [activeWalletId, activeStatus])
}
