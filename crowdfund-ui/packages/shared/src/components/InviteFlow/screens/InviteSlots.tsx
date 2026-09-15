// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (InviteFlow/screens/InviteSlots.tsx).
// ABOUTME: Internal default imports of @armada/ui primitives (Steps, Tooltip, WalletItem) were rewritten to named imports from the package barrel.

import { useState } from 'react'
import styles from './InviteSlots.module.css'
import { Tooltip } from '@armada/ui'
import SlotCard, { type SlotData } from './SlotCard'
import { INVITE_METHOD_PICKER_UX } from '../../../lib/inviteUx'
import { InviteFocusChrome, useInviteSlotFocus } from '../useInviteSlotFocus'

interface InviteSlotsProps {
  hopLevel?: string
  totalSlots?: number
}

export default function InviteSlots({
  hopLevel = 'Hop-1',
  totalSlots = 3,
}: InviteSlotsProps) {
  const [slots, setSlots] = useState<SlotData[]>(
    Array.from({ length: totalSlots }, (_, i) => ({
      id: i + 1,
      status: 'empty',
    }))
  )
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)
  const focusApi = useInviteSlotFocus()

  const handleGenerateLink = async (slotId: number) => {
    setLoadingId(slotId)
    await new Promise(r => setTimeout(r, 1200))
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    const link = `https://fund.armada.blue/join?invite=${Math.random().toString(36).slice(2, 10)}&hop=${hopLevel.toLowerCase()}`
    setSlots(prev =>
      prev.map(s =>
        s.id === slotId ? { ...s, status: 'link-active', link, expiresAt } : s
      )
    )
    setLoadingId(null)
  }

  const handleCopy = (slotId: number, link: string) => {
    navigator.clipboard.writeText(link)
    setCopiedId(slotId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleRevoke = (slotId: number) => {
    setSlots(prev =>
      prev.map(s => (s.id === slotId ? { id: s.id, status: 'empty' } : s))
    )
  }

  const handleInviteOnchain = async (
    slotId: number,
    address: string,
    ensName?: string
  ) => {
    setLoadingId(slotId)
    await new Promise(r => setTimeout(r, 1500))
    setSlots(prev =>
      prev.map(s =>
        s.id === slotId
          ? { ...s, status: 'onchain-pending', invitedAddress: address, ensName }
          : s
      )
    )
    setLoadingId(null)
  }

  const header = (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>Whitelist a friend</h2>
        <Tooltip
          variant="rich"
          title="How invite slots work"
          description="Each slot lets you bring one person into the fleet at Hop-1. Share a link or send an onchain invite to a specific address."
          bullets={[
            'Link slots are only consumed when someone redeems',
            'Onchain invites are immediate and irrevocable',
            'Links expire after 5 days — regenerating is free',
            'Anyone with a link can use it — share privately',
          ]}
        >
          <div className={styles.infoTrigger} aria-label="How invite slots work">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6.5" stroke="currentColor" strokeOpacity="0.4" />
              <path d="M7 6.5V9.5M7 4.5V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </div>
        </Tooltip>
      </div>
      <p className={styles.subtitle}>
        We need more sailors like you to join the fleet.
        <br />
        Share a link or send an onchain invite to a specific address.
      </p>
    </div>
  )

  const slotList = (
    <div className={styles.slotList}>
      {slots.map(slot => (
        <SlotCard
          key={slot.id}
          slot={slot}
          onGenerateLink={handleGenerateLink}
          onCopy={handleCopy}
          onRevoke={handleRevoke}
          onInviteOnchain={handleInviteOnchain}
          copied={copiedId === slot.id}
          loading={loadingId === slot.id}
          onInviteClick={INVITE_METHOD_PICKER_UX ? focusApi.openPicker : undefined}
          onInviteButtonRef={INVITE_METHOD_PICKER_UX ? focusApi.registerInviteButton : undefined}
          invitePickerOpen={focusApi.pickerSlotId === slot.id}
        />
      ))}
    </div>
  )

  const listFrame = (
    <div className={styles.listFrame}>
      {header}
      {slotList}
    </div>
  )

  return (
    <div className={styles.shell} data-invite-surface="">
      {INVITE_METHOD_PICKER_UX ? (
        <InviteFocusChrome
          focusApi={focusApi}
          loadingSlotId={loadingId}
          onGenerateLink={handleGenerateLink}
          onInviteOnchain={handleInviteOnchain}
          list={listFrame}
        />
      ) : (
        listFrame
      )}
    </div>
  )
}
