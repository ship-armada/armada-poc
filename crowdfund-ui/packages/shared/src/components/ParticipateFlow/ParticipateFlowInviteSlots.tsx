// ABOUTME: Modal-bound invite-slots step — renders one section per eligible hop, each with its own SlotCard list. Single-hop wallets see one un-headered section (designer-mockup behavior); multi-hop wallets see headered sections stacked vertically.
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/ParticipateFlowInviteSlots.tsx) and extended with the `sections` prop in place of the original flat slot/handlers props.

import { useState, type ReactNode } from 'react'
import SlotCard from '../InviteFlow/screens/SlotCard'
import { InviteFocusChrome, useInviteSlotFocus } from '../InviteFlow/useInviteSlotFocus'
import { Button } from '@armada/ui'
import { INVITE_METHOD_PICKER_UX } from '../../lib/inviteUx'
import type { CrowdfundInviteSlotSection } from '../CrowdfundExperience/CrowdfundExperience'
import inviteStyles from '../InviteFlow/screens/InviteSlots.module.css'
import styles from './ParticipateFlowInviteSlots.module.css'

export interface ParticipateFlowInviteSlotsProps {
  /** One section per eligible hop, each carrying its own slot list +
   *  handlers. Pass an empty array for the "no invite slots" empty state. */
  sections: ReadonlyArray<CrowdfundInviteSlotSection>
  onDoItLater?: () => void
  /** Rendered beneath the "Return" button — e.g. social links. */
  socials?: ReactNode
}

export function ParticipateFlowInviteSlots({
  sections,
  onDoItLater,
  socials,
}: ParticipateFlowInviteSlotsProps) {
  const focusApi = useInviteSlotFocus()
  const [activeSection, setActiveSection] = useState<CrowdfundInviteSlotSection | null>(null)

  // The wallet has no slot capacity at any hop (e.g. hop-2 invitee who can't
  // re-invite). Render the centered empty message in the shell.
  const isEmpty =
    sections.length === 0 || sections.every((s) => s.config.slots.length === 0)
  // Section headers are only meaningful when the user holds more than one
  // hop; single-hop users see the original layout unchanged.
  const showHeaders = sections.length > 1

  const listFrame = (
    <div className={inviteStyles.listFrame}>
      <div className={inviteStyles.header}>
        <h2 className={inviteStyles.title}>Whitelist a friend</h2>
        {!isEmpty && (
          <p className={inviteStyles.subtitle}>
            We need more sailors like you to join the fleet.
            <br />
            Share a link or send an onchain invite to a specific address.
          </p>
        )}
      </div>

      <div className={styles.scroll}>
        {isEmpty ? (
          <div className={styles.empty} role="status">
            <p className={styles.emptyText}>
              You have no invite slots available at this hop.
            </p>
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.hop} className={styles.section}>
              {showHeaders && (
                <div className={styles.sectionHeader}>
                  <span
                    className={styles.sectionDot}
                    style={{ background: section.hopColor }}
                    aria-hidden
                  />
                  <span className={styles.sectionLabel}>{section.hopLabel}</span>
                  <span className={styles.sectionCount}>
                    ({section.totalSlots} {section.totalSlots === 1 ? 'slot' : 'slots'})
                  </span>
                </div>
              )}
              <div className={inviteStyles.slotList}>
                {section.config.slots.map((slot) => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    onGenerateLink={section.config.onGenerateLink}
                    onCopy={section.config.onCopy}
                    onRevoke={section.config.onRevoke}
                    onInviteOnchain={section.config.onInviteOnchain}
                    copied={section.config.copiedId === slot.id}
                    loading={section.config.loadingId === slot.id}
                    resolveEns={section.config.resolveEns}
                    isWrongNetwork={section.config.isWrongNetwork}
                    onSwitchNetwork={section.config.onSwitchNetwork}
                    onInviteClick={
                      INVITE_METHOD_PICKER_UX
                        ? (slotId, anchor) => {
                            setActiveSection(section)
                            focusApi.openPicker(slotId, anchor)
                          }
                        : undefined
                    }
                    onInviteButtonRef={
                      INVITE_METHOD_PICKER_UX ? focusApi.registerInviteButton : undefined
                    }
                    invitePickerOpen={focusApi.pickerSlotId === slot.id}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )

  const actionHandlers = activeSection?.config

  return (
    <div className={styles.layout}>
      <div
        className={[inviteStyles.shell, styles.shell].join(' ')}
        data-invite-surface=""
      >
        {INVITE_METHOD_PICKER_UX && !isEmpty ? (
          <InviteFocusChrome
            focusApi={focusApi}
            loadingSlotId={actionHandlers?.loadingId ?? null}
            onGenerateLink={
              actionHandlers?.onGenerateLink ?? (async () => {})
            }
            onInviteOnchain={
              actionHandlers?.onInviteOnchain ?? (async () => {})
            }
            resolveEns={actionHandlers?.resolveEns}
            list={listFrame}
          />
        ) : (
          listFrame
        )}
      </div>

      {onDoItLater && focusApi.view === 'list' && (
        <div className={styles.footer}>
          <Button
            variant="ghost"
            size="md"
            label="Return"
            showIcon={false}
            onClick={onDoItLater}
          />
          {socials}
        </div>
      )}
    </div>
  )
}
