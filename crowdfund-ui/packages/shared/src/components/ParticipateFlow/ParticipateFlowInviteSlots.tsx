// ABOUTME: Modal-bound invite-slots step — reuses the InviteSlots shell + SlotCard list inside the Participate modal, adds a "Do it later" footer.
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/ParticipateFlowInviteSlots.tsx); `../Button` import rewritten to `@armada/ui`.

import SlotCard, { type SlotData } from '../InviteFlow/screens/SlotCard'
import { Button } from '@armada/ui'
import inviteStyles from '../InviteFlow/screens/InviteSlots.module.css'
import styles from './ParticipateFlowInviteSlots.module.css'

export interface ParticipateFlowInviteSlotsProps {
  slots: SlotData[]
  onGenerateLink: (slotId: number) => Promise<void>
  onCopy: (slotId: number, link: string) => void
  onRevoke: (slotId: number) => void
  onInviteOnchain: (slotId: number, address: string, ensName?: string) => Promise<void>
  onDoItLater?: () => void
  copiedId?: number | null
  loadingId?: number | null
}

export function ParticipateFlowInviteSlots({
  slots,
  onGenerateLink,
  onCopy,
  onRevoke,
  onInviteOnchain,
  onDoItLater,
  copiedId = null,
  loadingId = null,
}: ParticipateFlowInviteSlotsProps) {
  const isEmpty = slots.length === 0

  return (
    <div className={styles.layout}>
      <div className={[inviteStyles.shell, styles.shell].join(' ')}>
        <div className={inviteStyles.header}>
          <h2 className={inviteStyles.title}>Your invites</h2>
          {!isEmpty && (
            <p className={inviteStyles.subtitle}>
              Share a link or send an onchain invite to a specific address.
            </p>
          )}
        </div>

        <div className={styles.scroll}>
          {slots.length === 0 ? (
            <div className={styles.empty} role="status">
              <p className={styles.emptyText}>
                You have no invite slots available at this hop.
              </p>
            </div>
          ) : (
            <div className={inviteStyles.slotList}>
              {slots.map((slot) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  onGenerateLink={onGenerateLink}
                  onCopy={onCopy}
                  onRevoke={onRevoke}
                  onInviteOnchain={onInviteOnchain}
                  copied={copiedId === slot.id}
                  loading={loadingId === slot.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {onDoItLater && (
        <div className={styles.footer}>
          <Button
            variant="ghost"
            size="md"
            label="Return"
            showIcon={false}
            onClick={onDoItLater}
          />
        </div>
      )}
    </div>
  )
}
