// ABOUTME: Opens a feature modal (deposit, withdraw, send, earn) or triggers wallet connect when disconnected.
// ABOUTME: Remembers the clicked action and opens it automatically once wagmi reports a connection.

import { useCallback, useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { openModalAtom, type ActionModalKind } from '@/state/ui'

export function useOpenActionModal() {
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const setOpenModal = useSetAtom(openModalAtom)
  const pendingRef = useRef<ActionModalKind | null>(null)

  useEffect(() => {
    if (!isConnected || !pendingRef.current) return
    const kind = pendingRef.current
    pendingRef.current = null
    setOpenModal(kind)
  }, [isConnected, setOpenModal])

  const openActionModal = useCallback(
    (kind: ActionModalKind) => {
      if (!isConnected) {
        pendingRef.current = kind
        openConnectModal?.()
        return
      }
      setOpenModal(kind)
    },
    [isConnected, openConnectModal, setOpenModal],
  )

  return openActionModal
}
