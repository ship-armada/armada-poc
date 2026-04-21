// ABOUTME: Toast + atom helpers driven by transaction lifecycle events.
// ABOUTME: Mirrors the latest tx into lastTxAtom so the AppShell chip can follow along.

import { useCallback } from 'react'
import { atom, useSetAtom } from 'jotai'
import { toast } from 'sonner'

export type LastTxStatus = 'pending' | 'submitted' | 'confirmed' | 'failed'

export interface LastTx {
  status: LastTxStatus
  label: string
  hash: string | null
  explorerUrl?: string
  error?: string
  timestamp: number
}

/** Most recent transaction seen by `useTxToast` (or null if none this session). */
export const lastTxAtom = atom<LastTx | null>(null)

export interface UseTxToastOptions {
  /** Base URL of a block explorer (e.g. `https://sepolia.etherscan.io`). When set, submitted toasts get a "View" action linking to the tx. */
  explorerUrl?: string
}

export interface TxToastHandle {
  id: string | number
  label: string
  explorerUrl?: string
}

export interface UseTxToastResult {
  notifyTxPending(label: string): TxToastHandle
  notifyTxSubmitted(handle: TxToastHandle, hash: string): void
  notifyTxConfirmed(handle: TxToastHandle, message?: string): void
  notifyTxFailed(handle: TxToastHandle, errorMessage: string): void
}

function explorerAction(explorerUrl: string | undefined, hash: string) {
  if (!explorerUrl) return undefined
  return {
    label: 'View',
    onClick: () => {
      window.open(`${explorerUrl}/tx/${hash}`, '_blank', 'noopener,noreferrer')
    },
  }
}

/**
 * Imperative helpers that bridge tx lifecycle → sonner toasts + lastTxAtom.
 *
 * Usage (inside a hook that already manages submit/wait):
 * ```
 * const toast = useTxToast({ explorerUrl })
 * const h = toast.notifyTxPending('Commit 500 USDC')
 * const tx = await sendTx()
 * toast.notifyTxSubmitted(h, tx.hash)
 * const receipt = await tx.wait()
 * if (receipt.status === 1) toast.notifyTxConfirmed(h)
 * else toast.notifyTxFailed(h, 'Reverted')
 * ```
 */
export function useTxToast(opts?: UseTxToastOptions): UseTxToastResult {
  const explorerUrl = opts?.explorerUrl
  const setLastTx = useSetAtom(lastTxAtom)

  const notifyTxPending = useCallback(
    (label: string): TxToastHandle => {
      const id = toast.loading(label, {
        description: 'Waiting for wallet confirmation…',
      })
      setLastTx({
        status: 'pending',
        label,
        hash: null,
        explorerUrl,
        timestamp: Date.now(),
      })
      return { id, label, explorerUrl }
    },
    [setLastTx, explorerUrl],
  )

  const notifyTxSubmitted = useCallback(
    (handle: TxToastHandle, hash: string) => {
      toast.loading(handle.label, {
        id: handle.id,
        description: 'Submitted — waiting for confirmation…',
        action: explorerAction(handle.explorerUrl, hash),
      })
      setLastTx({
        status: 'submitted',
        label: handle.label,
        hash,
        explorerUrl: handle.explorerUrl,
        timestamp: Date.now(),
      })
    },
    [setLastTx],
  )

  const notifyTxConfirmed = useCallback(
    (handle: TxToastHandle, message?: string) => {
      toast.success(message ?? `${handle.label} confirmed`, {
        id: handle.id,
        description: undefined,
      })
      setLastTx((prev) => ({
        status: 'confirmed',
        label: handle.label,
        hash: prev?.hash ?? null,
        explorerUrl: handle.explorerUrl,
        timestamp: Date.now(),
      }))
    },
    [setLastTx],
  )

  const notifyTxFailed = useCallback(
    (handle: TxToastHandle, errorMessage: string) => {
      toast.error(`${handle.label} failed`, {
        id: handle.id,
        description: errorMessage,
      })
      setLastTx((prev) => ({
        status: 'failed',
        label: handle.label,
        hash: prev?.hash ?? null,
        explorerUrl: handle.explorerUrl,
        error: errorMessage,
        timestamp: Date.now(),
      }))
    },
    [setLastTx],
  )

  return { notifyTxPending, notifyTxSubmitted, notifyTxConfirmed, notifyTxFailed }
}
