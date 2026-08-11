// ABOUTME: ReceiveDialog — surfaces the user's full 0zk shielded address with a copy-to-clipboard CTA, opened via openModalAtom='receive' from the BalanceHero "Receive" button.
// ABOUTME: Only renders when the wallet is unlocked AND has a shieldedAddress; closes itself on lock/disconnect mid-display by reading the same atom every render.

import { useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/solid'
import { Button } from '@armada/ui'
import { Modal } from '@/components/ui'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'
import { openModalAtom } from '@/state/ui'
import styles from './ReceiveDialog.module.css'

const COPY_FEEDBACK_MS = 2000

export function ReceiveDialog() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const { state } = useShieldedWallet()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isOpen = openModal === 'receive'
  const fullAddress =
    state?.status === 'unlocked' && state.shieldedAddress ? state.shieldedAddress : null

  // Defensive auto-close: if the wallet locks while the dialog is open (auto-lock fires,
  // disconnect lands), drop the modal kind so the parent re-renders without it. Avoids
  // showing a stale address card with nothing to copy.
  useEffect(() => {
    if (isOpen && !fullAddress) setOpenModal(null)
  }, [isOpen, fullAddress, setOpenModal])

  // Reset the "Copied" pill whenever the dialog is closed so re-opening starts fresh.
  useEffect(() => {
    if (!isOpen) {
      setCopied(false)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [isOpen])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  async function handleCopy() {
    if (!fullAddress) return
    try {
      await navigator.clipboard.writeText(fullAddress)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    } catch {
      setCopied(false)
    }
  }

  if (!isOpen || !fullAddress) return null

  return (
    <Modal
      open={isOpen}
      onClose={() => setOpenModal(null)}
      title="Receive USDC privately"
    >
      <p className={styles.copy}>
        Share this address to receive USDC into your private balance.
      </p>
      <div className={styles.addressCard}>
        <span className={styles.address}>{fullAddress}</span>
      </div>
      <Button
        variant="primary"
        size="md"
        label={copied ? 'Copied' : 'Copy address'}
        leadingIcon={
          copied ? (
            <CheckIcon width={16} height={16} aria-hidden />
          ) : (
            <ClipboardDocumentIcon width={16} height={16} aria-hidden />
          )
        }
        showIcon={false}
        onClick={() => void handleCopy()}
        className={styles.copyButton}
      />
    </Modal>
  )
}
