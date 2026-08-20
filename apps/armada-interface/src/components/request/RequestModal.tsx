// ABOUTME: RequestModal — the "Request USDC via link" flow: compose (amount/expiry/note) → generated link screen.
// ABOUTME: Opened via openModalAtom='request'. Builds a real pay-via-link from the user's 0zk address; copy-address hands off to ReceiveDialog.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom } from '@/state/ui'
import { shieldedWalletAtom, activeShieldedWalletIdAtom } from '@/state/wallet'
import { requestShareIntentAtom } from '@/state/requestLinks'
import { useAddRequestLink } from '@/hooks/useRequestLinks'
import { FlowShell } from '@/components/flow/FlowShell'
import { useFlowExit } from '@/components/flow/useFlowExit'
import {
  DEFAULT_REQUEST_LINK_EXPIRY_ID,
  buildPayViaLinkUrl,
  createPaymentRequestId,
  requestLinkExpiryMs,
  type RequestLinkExpiryId,
} from '@/lib/payViaLink'
import { RequestReceiveScreen } from './RequestReceiveScreen'
import { RequestLinkScreen } from './RequestLinkScreen'

const REQUEST_STEPS = ['Receive', 'Share link']

type RequestStep = 'receive' | 'link'

export function RequestModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const shieldedWallet = useAtomValue(shieldedWalletAtom)
  const activeWalletId = useAtomValue(activeShieldedWalletIdAtom)
  const [shareIntent, setShareIntent] = useAtom(requestShareIntentAtom)
  const addRequestLink = useAddRequestLink()
  const isOpen = openModal === 'request'

  const [step, setStep] = useState<RequestStep>('receive')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [expiryId, setExpiryId] = useState<RequestLinkExpiryId>(DEFAULT_REQUEST_LINK_EXPIRY_ID)
  const [paymentLink, setPaymentLink] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  // Revoke isn't wired yet (needs backend state), so the link is never revoked in-app. The
  // RequestLinkScreen's revoked variant is built + ready for when real revocation lands.
  const [linkRevoked] = useState(false)

  // Re-open at the Share step from a "Payment link created" activity row: seed the stored link
  // synchronously on the open transition so FlowShell's stepKey is 'link' on the first paint (no
  // compose-step flash). The intent is consumed in an effect below. See SendModal for the pattern.
  const [wasOpen, setWasOpen] = useState(false)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen && shareIntent) {
      setAmount(shareIntent.amount)
      setNote(shareIntent.note ?? '')
      setPaymentLink(shareIntent.paymentLink)
      setExpiresAt(shareIntent.expiresAt)
      setStep('link')
    }
  }

  // Reset on close so re-opening (without a share intent) starts fresh at the compose step.
  useEffect(() => {
    if (isOpen) return
    setStep('receive')
    setAmount('')
    setNote('')
    setExpiryId(DEFAULT_REQUEST_LINK_EXPIRY_ID)
    setPaymentLink('')
    setExpiresAt(0)
  }, [isOpen])

  // Consume the share intent once opened (post-commit; the render-time block above already seeded).
  useEffect(() => {
    if (isOpen && shareIntent) setShareIntent(null)
  }, [isOpen, shareIntent, setShareIntent])

  const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))

  function handleCreateLink() {
    const recipientAddress = shieldedWallet.shieldedAddress
    if (!recipientAddress || !activeWalletId) return
    const requestId = createPaymentRequestId()
    const nextExpiresAt = Date.now() + requestLinkExpiryMs(expiryId)
    const trimmedNote = note.trim()
    const link = buildPayViaLinkUrl({
      recipientAddress,
      requestId,
      expiresAt: nextExpiresAt,
      amount,
      note: trimmedNote || undefined,
    })
    setPaymentLink(link)
    setExpiresAt(nextExpiresAt)
    setStep('link')
    // Persist for Recent Activity (encrypted, per-wallet). Fire-and-forget — a storage failure
    // shouldn't block showing the link the user just created.
    void addRequestLink({
      requestId,
      paymentLink: link,
      amount,
      note: trimmedNote || undefined,
      expiresAt: nextExpiresAt,
      createdAt: Date.now(),
      shieldedWalletId: activeWalletId,
    })
  }

  if (!isOpen && !exiting) return null

  const currentStep = step === 'link' ? 2 : 1

  return (
    <FlowShell
      open={isOpen}
      exiting={exiting}
      onClose={close}
      flowLabel="Request"
      steps={REQUEST_STEPS}
      currentStep={currentStep}
      stepKey={step}
    >
      {step === 'receive' ? (
        <RequestReceiveScreen
          amount={amount}
          note={note}
          expiryId={expiryId}
          onAmountChange={setAmount}
          onNoteChange={setNote}
          onExpiryChange={setExpiryId}
          onCancel={close}
          onCreateLink={handleCreateLink}
        />
      ) : (
        <RequestLinkScreen
          paymentLink={paymentLink}
          amount={amount || undefined}
          expiresAt={expiresAt}
          revoked={linkRevoked}
          onDone={close}
        />
      )}
    </FlowShell>
  )
}
