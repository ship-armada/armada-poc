// ABOUTME: Standalone v2 Invite Slots page reached from the header Invite button.
// ABOUTME: Renders one section per eligible hop, driven by the per-hop sections from `useInviteSlots`. Single-hop wallets see one un-headered section; multi-hop wallets see hop-labeled sections stacked vertically.

import { ConnectButton } from '@rainbow-me/rainbowkit'
import {
  SlotCard,
  type CrowdfundInviteSlotSection,
} from '@armada/crowdfund-shared'
import { Tooltip, Button as ArmadaButton } from '@armada/ui'

export interface InviteSlotsPageProps {
  walletConnected: boolean
  /** True when the wallet has no eligibility positions at all. */
  empty: boolean
  /** Per-hop slot sections. Empty array short-circuits to the "no slots" copy
   *  alongside `empty`. */
  sections: ReadonlyArray<CrowdfundInviteSlotSection>
  onBack: () => void
}

export function InviteSlotsPage({
  walletConnected,
  empty,
  sections,
  onBack,
}: InviteSlotsPageProps) {
  if (!walletConnected) {
    return (
      <Centered>
        <h1 className="mb-2 text-2xl">Connect your wallet to invite</h1>
        <p className="mb-6 text-muted-foreground">
          Each whitelisted participant has invite slots they can share with the wider fleet.
          Connect your wallet to see yours.
        </p>
        <ConnectButton />
      </Centered>
    )
  }

  const noSlotsAtAnyHop =
    !empty && (sections.length === 0 || sections.every((s) => s.config.slots.length === 0))

  if (empty) {
    return (
      <Centered>
        <h1 className="mb-2 text-2xl">No invite slots available</h1>
        <p className="mb-6 text-muted-foreground">
          This address hasn't been whitelisted for the crowdfund. Once you've committed at a hop
          with invite slots, you'll be able to manage them here.
        </p>
        <ArmadaButton
          variant="secondary"
          size="md"
          label="Back to crowdfund"
          showIcon={false}
          onClick={onBack}
        />
      </Centered>
    )
  }

  if (noSlotsAtAnyHop) {
    const hopList = sections.map((s) => s.hopLabel).join(' / ') || 'this address'
    return (
      <Centered>
        <h1 className="mb-2 text-2xl">No invite slots available</h1>
        <p className="mb-6 text-muted-foreground">
          You have no invite slots available at {hopList}.
        </p>
        <ArmadaButton
          variant="secondary"
          size="md"
          label="Back to crowdfund"
          showIcon={false}
          onClick={onBack}
        />
      </Centered>
    )
  }

  // Section headers are only meaningful when the wallet holds more than one
  // hop; single-hop wallets see the original layout unchanged.
  const showHeaders = sections.length > 1
  // Compose a friendly hop list for the tooltip body ("SEED", "SEED + HOP-1").
  const hopListDesc = sections.map((s) => s.hopLabel).join(' + ')

  return (
    // 12rem = 2 × (AppShell main `pt-20` + container `p-4-top`) — keeps the
    // card centered on the viewport's visual midline. See ClaimFlowV2's
    // FlowShell for the derivation.
    <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-[color:var(--semantic-color-border-lavender)] bg-[color:var(--semantic-color-surface-default)] p-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-2">
            <h1 className="text-xl text-foreground">Your invites</h1>
            <Tooltip
              variant="rich"
              title="How invite slots work"
              description={`Each slot lets you bring one person into the fleet at the next hop down (you hold ${hopListDesc}). Share a link or send an onchain invite to a specific address.`}
              bullets={[
                'Link slots are only consumed when someone redeems',
                'Onchain invites are immediate and irrevocable',
                'Links expire after 5 days — regenerating is free',
                'Anyone with a link can use it — share privately',
              ]}
            >
              <span
                className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center text-muted-foreground"
                aria-label="How invite slots work"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="6.5" stroke="currentColor" strokeOpacity="0.4" />
                  <path
                    d="M7 6.5V9.5M7 4.5V5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </Tooltip>
          </div>
          <p className="text-sm text-muted-foreground">
            Share a link or send an onchain invite to a specific address.
          </p>
        </div>

        {/* `max-h-[360px]` mirrors the inline MyPosition card and the modal
            invite-slots step — ~3-4 SlotCards visible before scroll. */}
        <div className="flex max-h-[360px] flex-col gap-5 overflow-y-auto pr-1">
          {sections.map((section) => (
            <div key={section.hop} className="flex flex-col gap-3">
              {showHeaders && (
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: section.hopColor }}
                    aria-hidden
                  />
                  <span className="text-foreground">{section.hopLabel}</span>
                  <span>
                    ({section.totalSlots} {section.totalSlots === 1 ? 'slot' : 'slots'})
                  </span>
                </div>
              )}
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
                />
              ))}
            </div>
          ))}
        </div>

        <div className="mt-6 flex justify-center">
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Back to crowdfund"
            showIcon={false}
            onClick={onBack}
          />
        </div>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 text-center">
      {children}
    </div>
  )
}
