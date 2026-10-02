// ABOUTME: Post-commit Whitelist a friend modal — hop allowance rows + in-place invite actions.
// ABOUTME: Matches InvitesCard hop-row pattern; wired to live CrowdfundInviteSlotSection handlers.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button } from '@armada/ui'
import { FlowChrome } from './FlowChrome'
import {
  InviteHopFocusChrome,
  useInviteHopFocus,
} from '../InviteFlow/useInviteSlotFocus'
import type { CrowdfundInviteSlotSection } from '../CrowdfundExperience/CrowdfundExperience'
import { HopAvailableRow } from '../MyPosition/InvitesCard'
import inviteCardStyles from '../MyPosition/InvitesCard.module.css'
import {
  availableForHop,
  formatInviteeHop,
  hopsWithAllowance,
  type InviteeHop,
} from '../MyPosition/inviteModel'
import {
  allowanceFromInviteSections,
  firstEmptySlotId,
  inviteOnchainViaSections,
  issuedSlotsFromInviteSections,
  revokeLinkViaSections,
  sectionForInviteeHop,
} from '../MyPosition/inviteSectionsToCard'
import { useIsMobileLayout } from '../../hooks/useIsMobileLayout'
import inviteStyles from '../InviteFlow/screens/InviteSlots.module.css'
import styles from './ParticipateFlowInviteSlots.module.css'

export interface ParticipateFlowInviteSlotsProps {
  /** One section per eligible hop, each carrying its own slot list +
   *  handlers. Pass an empty array for the "no invite slots" empty state. */
  sections: ReadonlyArray<CrowdfundInviteSlotSection>
  /** Connected wallet — self-invite CTA when the pasted address matches. */
  selfWalletAddress?: string
  onDoItLater?: () => void
  /** FlowChrome back — returns to the previous participate step (usually confirmation). */
  onBack?: () => void
  /** FlowChrome close — dismisses the participate invite step. */
  onClose?: () => void
  /** Reveal a just-created invite in the sent list (Done). */
  onConfirmCreated?: (inviteId: number) => void
  /** Free the slot if the create confirmation is abandoned / discarded. */
  onDiscardCreated?: (inviteId: number) => void
  /** Rendered beneath the "Do it later" button — e.g. social links. */
  socials?: ReactNode
}

function whitelistSubtitle(
  sections: ReadonlyArray<CrowdfundInviteSlotSection>,
): string {
  const allowance = allowanceFromInviteSections(sections)
  const issuedSlots = issuedSlotsFromInviteSections(sections)
  const hopRows = hopsWithAllowance(allowance)
  const availableHops = hopRows.filter(
    (hop) => availableForHop(issuedSlots, allowance, hop) > 0,
  )
  const total = availableHops.reduce(
    (sum, hop) => sum + availableForHop(issuedSlots, allowance, hop),
    0,
  )
  if (total <= 0) {
    return 'You have no invites left to send right now.'
  }
  const countLabel = total === 1 ? '1 invite left' : `${total} invites left`
  if (availableHops.length === 1) {
    const hop = availableHops[0]
    return `You have ${countLabel} for ${formatInviteeHop(hop!)}. Share a link (no gas) or whitelist an address onchain so a friend can join.`
  }
  return `You have ${countLabel}. Share a link (no gas) or whitelist an address onchain so a friend can join the fleet.`
}

export function ParticipateFlowInviteSlots({
  sections,
  selfWalletAddress,
  onDoItLater,
  onBack,
  onClose,
  onConfirmCreated,
  onDiscardCreated,
  socials,
}: ParticipateFlowInviteSlotsProps) {
  const isMobile = useIsMobileLayout()
  const focusApi = useInviteHopFocus()
  const [rollFromByHop, setRollFromByHop] = useState<
    Partial<Record<InviteeHop, number>>
  >({})
  const actionAvailableSnapshotRef = useRef<Partial<
    Record<InviteeHop, number>
  > | null>(null)

  const allowance = useMemo(
    () => allowanceFromInviteSections(sections),
    [sections],
  )
  const issuedSlots = useMemo(
    () => issuedSlotsFromInviteSections(sections),
    [sections],
  )
  const hopRows = useMemo(() => hopsWithAllowance(allowance), [allowance])

  const isEmpty = hopRows.length === 0
  const isActionView = focusApi.view === 'action'
  /** Mobile keeps the hop list under the action sheet — do not swap the chrome. */
  const isInPlaceAction = isActionView && !isMobile
  const subtitle = useMemo(() => whitelistSubtitle(sections), [sections])

  const loadingHop = useMemo((): InviteeHop | null => {
    for (const section of sections) {
      if (section.config.loadingId == null) continue
      const invitee = (section.hop + 1) as InviteeHop
      if (invitee === 1 || invitee === 2) return invitee
    }
    return null
  }, [sections])

  const copiedInviteId = useMemo(() => {
    for (const section of sections) {
      if (section.config.copiedId != null) return section.config.copiedId
    }
    return null
  }, [sections])

  const resolveEns = sections[0]?.config.resolveEns

  // Snapshot available counts when entering the action screen so we can roll
  // the hop thumb down when returning after a successful invite.
  useEffect(() => {
    if (isActionView) {
      if (actionAvailableSnapshotRef.current == null) {
        const snap: Partial<Record<InviteeHop, number>> = {}
        for (const hop of hopRows) {
          snap[hop] = availableForHop(issuedSlots, allowance, hop)
        }
        actionAvailableSnapshotRef.current = snap
      }
      return
    }

    const snap = actionAvailableSnapshotRef.current
    if (!snap) return
    actionAvailableSnapshotRef.current = null
    const nextRoll: Partial<Record<InviteeHop, number>> = {}
    for (const hop of hopRows) {
      const from = snap[hop]
      const to = availableForHop(issuedSlots, allowance, hop)
      if (from != null && from > to) nextRoll[hop] = from
    }
    if (Object.keys(nextRoll).length > 0) setRollFromByHop(nextRoll)
  }, [isActionView, hopRows, issuedSlots, allowance])

  const handleGenerateLink = useCallback(
    async (hop: InviteeHop) => {
      const section = sectionForInviteeHop(sections, hop)
      if (!section) return
      if (section.config.isWrongNetwork) {
        section.config.onSwitchNetwork?.()
        return
      }
      const emptyId = firstEmptySlotId(section)
      if (emptyId == null) return
      const created = await section.config.onGenerateLink(emptyId)
      if (
        created &&
        typeof created === 'object' &&
        'link' in created &&
        'expiresAt' in created &&
        'id' in created &&
        typeof created.link === 'string' &&
        created.expiresAt instanceof Date &&
        typeof created.id === 'number'
      ) {
        return {
          id: created.id,
          link: created.link,
          expiresAt: created.expiresAt,
        }
      }
    },
    [sections],
  )

  const handleInviteOnchain = useCallback(
    (hop: InviteeHop, address: string, ensName?: string) =>
      inviteOnchainViaSections(sections, hop, address, ensName),
    [sections],
  )

  const handleCopy = useCallback(
    (id: number, link: string) => {
      for (const section of sections) {
        if (section.config.slots.some((slot) => slot.id === id)) {
          section.config.onCopy(id, link)
          return
        }
      }
    },
    [sections],
  )

  // Revoke by the link itself, never by `id`: live rows re-sort as on-chain
  // invites land, so a captured slot id can point at a different pending link.
  const handleRevoke = useCallback(
    async (_id: number, link?: string) => {
      if (link) revokeLinkViaSections(sections, link)
    },
    [sections],
  )

  const hopList = (
    <div className={inviteCardStyles.hopList} role="list">
      {hopRows.map((hop) => {
        const available = availableForHop(issuedSlots, allowance, hop)
        return (
          <HopAvailableRow
            key={hop}
            hop={hop}
            available={available}
            rollFrom={rollFromByHop[hop]}
            pickerOpen={focusApi.pickerHop === hop}
            onInviteClick={(h, anchor) => focusApi.openPicker(h, anchor)}
            inviteButtonRef={(el) => focusApi.registerInviteButton(hop, el)}
            onRollComplete={() =>
              setRollFromByHop((prev) => {
                if (prev[hop] == null) return prev
                const next = { ...prev }
                delete next[hop]
                return next
              })
            }
          />
        )
      })}
    </div>
  )

  const listBody = (
    <div className={styles.scroll}>
      {isEmpty ? (
        <div className={styles.empty} role="status">
          <p className={styles.emptyText}>
            You have no invite slots available at this hop.
          </p>
        </div>
      ) : (
        hopList
      )}
    </div>
  )

  return (
    <div className={styles.layout}>
      <div
        className={[inviteStyles.shell, styles.shell].join(' ')}
        data-flow-shell
        data-invite-surface=""
      >
        {/* Chrome stays outside the list↔action crossfade so back/close never drop out. */}
        {!isInPlaceAction ? (
          <div className={styles.chromeBlock}>
            <FlowChrome
              title="Whitelist a friend"
              titleId="whitelist-friend-title"
              onBack={onBack}
              onClose={onClose}
              closeAriaLabel="Close invite flow"
              backAriaLabel="Back to confirmation"
            />
            {!isEmpty ? (
              <p className={styles.subtitle}>{subtitle}</p>
            ) : null}
          </div>
        ) : null}

        {!isEmpty ? (
          <InviteHopFocusChrome
            focusApi={focusApi}
            loadingHop={loadingHop}
            onGenerateLink={handleGenerateLink}
            onInviteOnchain={handleInviteOnchain}
            onCopy={handleCopy}
            onRevoke={handleRevoke}
            onConfirmCreated={onConfirmCreated}
            onDiscardCreated={onDiscardCreated}
            copiedInviteId={copiedInviteId}
            resolveEns={resolveEns}
            selfWalletAddress={selfWalletAddress}
            list={listBody}
          />
        ) : (
          listBody
        )}
      </div>

      {onDoItLater && focusApi.view === 'list' && (
        <div className={styles.footer}>
          <Button
            variant="ghost"
            size="md"
            label="Do it later"
            showIcon={false}
            onClick={onDoItLater}
          />
          {socials}
        </div>
      )}
    </div>
  )
}
