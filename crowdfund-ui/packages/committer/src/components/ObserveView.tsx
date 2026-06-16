// ABOUTME: Committer "Observe" page — read-only cards over the no-WebGL splash background, no 3D node graph.
// ABOUTME: Status card (phase + progress bar + hop stats), participants table, and event log — all from the already-polled contract state + events.

import type { JsonRpcProvider } from 'ethers'
import { SplashBackdrop, type ContractState, type CrowdfundEvent } from '@armada/crowdfund-shared'
import { ObserveStatusCard } from '@/components/ObserveStatusCard'
import { ObserveParticipantsTable } from '@/components/ObserveParticipantsTable'
import { ObserveEventLog } from '@/components/ObserveEventLog'

/**
 * Observe page. Renders the subdued splash as a fixed full-bleed page background
 * with a single-column card layout on top. No CrowdfundExperience / NodeSphere,
 * so the 3D graph never mounts on this view.
 */
export function ObserveView({
  state,
  events,
  eventsLoading,
  provider,
}: {
  state: ContractState
  events: CrowdfundEvent[]
  eventsLoading: boolean
  provider: JsonRpcProvider | null
}) {
  return (
    <div className="relative min-h-screen w-full">
      {/* Fixed full-bleed splash background — behind the content; the floating
          header (higher z) still renders over it. */}
      <div className="fixed inset-0 z-0">
        <SplashBackdrop />
      </div>

      {/* Header backdrop (Observe-only) — frosts content scrolling under the
          floating, transparent AppHeader so it doesn't bleed through. Sits below
          the header (z-40) and above the page content (z-10); masked to fade out
          just below the header band so it's near-invisible when unscrolled. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-30"
        style={{
          height: '120px',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          background: 'color-mix(in srgb, var(--semantic-color-surface-default) 55%, transparent)',
          maskImage: 'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)',
        }}
      />

      {/* Content — pt-24 clears the floating header. */}
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-16 pt-24">
        <ObserveStatusCard state={state} />
        <ObserveParticipantsTable events={events} phase={state.phase} provider={provider} />
        <ObserveEventLog events={events} loading={eventsLoading} provider={provider} />
      </div>
    </div>
  )
}
