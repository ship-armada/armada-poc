// ABOUTME: usePayViaLinkIntent — hydrates a pending pay-via-link hand-off and opens the prefilled Send.
// ABOUTME: Reads the sessionStorage pending link (set by the landing page); SendModal seeds + clears it.

import { useEffect } from 'react'
import { useAtom } from 'jotai'
import { openModalAtom, paymentIntentAtom } from '@/state/ui'
import { readPendingPayViaLink } from '@/lib/payViaLink'
import { useShieldedWallet } from '@/hooks/useShieldedWallet'

/**
 * Mounted once at App level. When the payer lands from a `/pay-via-link` link and hits "Continue to
 * pay", the landing writes a pending hand-off + navigates to the dashboard; this hydrates that into
 * `paymentIntentAtom` and — once the wallet is unlocked and nothing else is open — opens the Send
 * flow, which seeds the recipient/amount from the intent and clears it.
 */
export function usePayViaLinkIntent(): void {
  const [intent, setIntent] = useAtom(paymentIntentAtom)
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const { state } = useShieldedWallet()
  const unlocked = state?.status === 'unlocked'

  // Hydrate the intent from the pending sessionStorage hand-off on mount (survives a full reload).
  useEffect(() => {
    if (intent) return
    const pending = readPendingPayViaLink()
    if (pending) setIntent({ recipient: pending.recipient, amount: pending.amount })
    // Mount-only: the landing client-navigates here, so App mounts fresh with the pending set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drop the payer into the prefilled Send once the wallet is ready and nothing else is open.
  useEffect(() => {
    if (!intent || !unlocked || openModal !== null) return
    setOpenModal('payment')
  }, [intent, unlocked, openModal, setOpenModal])
}
