// ABOUTME: Spike scaffold for the committer "Observe" page — cards + tables, no 3D node graph.
// ABOUTME: Placeholder layout (one full-width card, then a two-column row) over the no-WebGL splash as the page background.

import type { JsonRpcProvider } from 'ethers'
import { SplashBackdrop, type ContractState, type CrowdfundEvent } from '@armada/crowdfund-shared'
import { ObserveStatusCard } from '@/components/ObserveStatusCard'
import { ObserveParticipantsTable } from '@/components/ObserveParticipantsTable'

/** Placeholder card — translucent surface over the splash so the backdrop reads
 *  through. Swap for real StatsBar / TableView content once the layout lands. */
function PlaceholderCard({ label, minHeight = 200 }: { label: string; minHeight?: number }) {
  return (
    <div
      style={{
        minHeight,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'color-mix(in srgb, var(--semantic-color-surface-raised) 72%, transparent)',
        border: '1px solid var(--semantic-color-border-default)',
        borderRadius: 'calc(var(--semantic-borderRadius-card) * 1px)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        boxShadow: '0 12px 28px -16px rgba(0, 0, 0, 0.55)',
        color: 'var(--semantic-color-text-secondary)',
        fontFamily: 'var(--primitives-fontFamily-ui)',
        fontSize: 'calc(var(--primitives-fontSize-base) * 1px)',
      }}
    >
      {label}
    </div>
  )
}

/**
 * Observe page (spike). Renders the subdued splash as a fixed full-bleed page
 * background with a card layout on top: one card across the top, then two cards
 * in a two-column row (stacked on mobile). No CrowdfundExperience / NodeSphere,
 * so the 3D graph never mounts on this view.
 */
export function ObserveView({
  state,
  events,
  provider,
}: {
  state: ContractState
  events: CrowdfundEvent[]
  provider: JsonRpcProvider | null
}) {
  return (
    <div className="relative min-h-screen w-full">
      {/* Fixed full-bleed splash background — behind the content; the floating
          header (higher z) still renders over it. */}
      <div className="fixed inset-0 z-0">
        <SplashBackdrop />
      </div>

      {/* Content — pt-24 clears the floating header. */}
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-16 pt-24">
        <ObserveStatusCard state={state} />
        <ObserveParticipantsTable events={events} phase={state.phase} provider={provider} />
        {/* Placeholder — real content planned. */}
        <PlaceholderCard label="Card B" minHeight={240} />
      </div>
    </div>
  )
}
