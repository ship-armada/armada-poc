// ABOUTME: Tests for CrowdfundExperience's hero cards: My Position CTAs, Progress actions, pre-open card.
// ABOUTME: Also covers the invite card taking the Participate card's slot once the wallet has committed.
// @vitest-environment jsdom

import { act, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  CrowdfundExperience,
  type CrowdfundExperienceMyPositionData,
  type CrowdfundInviteSlotSection,
} from './CrowdfundExperience'

// The WebGL graph isn't under test and can't render in jsdom.
vi.mock('../NodeSphere/NodeSphere', () => ({
  NodeSphere: () => null,
  isWebglForcedOff: () => false,
}))

beforeAll(() => {
  // jsdom doesn't implement media playback; the Participate card's fleet video calls these.
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

const WALLET = '0x' + 'a'.repeat(40)

function readyPosition(committedUsdc: bigint): CrowdfundExperienceMyPositionData {
  return {
    status: 'ready',
    walletAddress: WALLET,
    walletDisplay: '0xaaaa…aaaa',
    hop: 0,
    committedUsdc,
    capUsdc: 15_000n * 1_000_000n,
    armAllocation: 0n,
    positions: [
      {
        hop: 0,
        committed: committedUsdc,
        cap: 15_000n * 1_000_000n,
        invitesReceived: 1,
        invitesAvailable: 3,
        invitesUsed: 0,
      },
    ],
  }
}

function renderMyPosition(myPositionData: CrowdfundExperienceMyPositionData) {
  render(
    <CrowdfundExperience
      view="myposition"
      myPositionData={myPositionData}
      inviteSlotSections={[]}
      onParticipate={vi.fn()}
    />,
  )
}

// The card has a header CTA and a mobile footer CTA; both must agree.
describe('CrowdfundExperience My Position participate CTAs', () => {
  it('shows "Participate" for an invited wallet that has not committed yet', () => {
    renderMyPosition(readyPosition(0n))
    const card = within(screen.getByRole('region', { name: 'Your position' }))
    expect(card.getAllByRole('button', { name: /Participate/ })).toHaveLength(2)
    expect(card.queryByRole('button', { name: /Commit again/ })).toBeNull()
  })

  it('shows "Commit again" once the wallet has committed', () => {
    renderMyPosition(readyPosition(500n * 1_000_000n))
    const card = within(screen.getByRole('region', { name: 'Your position' }))
    expect(card.getAllByRole('button', { name: /Commit again/ })).toHaveLength(2)
    expect(card.queryByRole('button', { name: /Participate/ })).toBeNull()
  })
})

describe('CrowdfundExperience Your position fill bar', () => {
  it('captions the fill as a share of the hop cap', () => {
    renderMyPosition(readyPosition(500n * 1_000_000n))
    const card = within(screen.getByRole('region', { name: 'Your position' }))
    expect(card.getByText(/% of hop cap$/)).toBeTruthy()
  })
})

// The full crowdfund view is heavy to render (~3–4s in jsdom); allow headroom
// so a parallel suite run doesn't trip the default 5s timeout.
describe('CrowdfundExperience progress card actions', { timeout: 20_000 }, () => {
  function renderCrowdfund(claimAvailable: boolean) {
    render(
      <CrowdfundExperience
        view="crowdfund"
        inviteSlotSections={[]}
        onParticipate={vi.fn()}
        onDetails={vi.fn()}
        onClaim={vi.fn()}
        claimAvailable={claimAvailable}
      />,
    )
  }

  it('keeps Details beside Claim (not over it) once Claim is available', () => {
    renderCrowdfund(true)
    // Desktop: Details sits in the same action group as Claim (the card also
    // renders a footer copy of the action for mobile).
    const group = screen
      .getAllByRole('button', { name: /^Claim/ })
      .map((b) => b.parentElement as HTMLElement)
      .find((g) => within(g).queryByRole('button', { name: 'Details' }))
    expect(group).toBeTruthy()
    // The corner overlay is kept for mobile only (Claim moves to the footer there).
    const overlay = screen
      .getAllByRole('button', { name: 'Details' })
      .find((b) => !group!.contains(b) && !b.closest('[class*="footerAction"]'))
    expect(overlay?.className).toMatch(/detailsBtnMobileOnly/)
  })

  it('shows only the corner Details when there is no Claim action', () => {
    renderCrowdfund(false)
    const details = screen.getAllByRole('button', { name: 'Details' })
    expect(details).toHaveLength(1)
    expect(details[0].className).not.toMatch(/detailsBtnMobileOnly/)
  })
})


describe('CrowdfundExperience pre-open card', { timeout: 20_000 }, () => {
  function renderCrowdfund(opensAtUnix: number | undefined) {
    render(
      // No header — the showcase default header carries its own demo CTA;
      // the committer passes its own (window-gated) header.
      <CrowdfundExperience
        view="crowdfund"
        header={null}
        inviteSlotSections={[]}
        onParticipate={vi.fn()}
        participationEnabled={false}
        liveData={{
          status: 'ready',
          dashRows: [],
          totalCommitted: 0,
          ...(opensAtUnix !== undefined ? { opensAtUnix } : {}),
        }}
      />,
    )
  }

  it('shows the opening countdown in place of the Participate card before the window opens', () => {
    renderCrowdfund(Math.floor(Date.now() / 1000) + 3 * 86400)
    expect(screen.getByRole('region', { name: 'Sale opens soon' })).toBeTruthy()
    // Neither the fleet card nor the empty participants list offers Participate
    // (`hidden` — the collapsed list stays mounted under aria-hidden).
    expect(screen.queryByRole('button', { name: /Participate/, hidden: true })).toBeNull()
  })

  it('shows no pre-open card once the window is past opening', () => {
    renderCrowdfund(undefined)
    expect(screen.queryByRole('region', { name: 'Sale opens soon' })).toBeNull()
  })
})

function inviteSection(hop: 0 | 1 | 2, totalSlots: number): CrowdfundInviteSlotSection {
  return {
    hop,
    hopLabel: `HOP-${hop}`,
    hopColor: '#ffffff',
    totalSlots,
    config: {
      slots: Array.from({ length: totalSlots }, (_, i) => ({
        id: hop * 100 + i,
        status: 'empty' as const,
      })),
      copiedId: null,
      loadingId: null,
      onGenerateLink: vi.fn().mockResolvedValue(undefined),
      onCopy: vi.fn(),
      onRevoke: vi.fn(),
      onInviteOnchain: vi.fn().mockResolvedValue(false),
    },
  }
}

// Once a wallet has committed and holds invite slots, the invite card takes
// the Participate card's place on the Crowdfund view.
describe('CrowdfundExperience invite card on the Crowdfund view', { timeout: 20_000 }, () => {
  function experience(
    view: 'crowdfund' | 'myposition',
    committedUsdc: bigint,
    sections: CrowdfundInviteSlotSection[],
    participationEnabled = true,
  ) {
    return (
      <CrowdfundExperience
        view={view}
        header={null}
        inviteSlotSections={sections}
        myPositionData={readyPosition(committedUsdc)}
        onParticipate={vi.fn()}
        participationEnabled={participationEnabled}
        liveData={{ status: 'ready', dashRows: [], totalCommitted: 0 }}
      />
    )
  }

  const participateCard = () => screen.queryByRole('button', { name: 'Participate: Join the fleet' })
  const inviteCard = () => screen.queryByRole('region', { name: 'Whitelist a friend' })

  it('replaces the Participate card once the wallet has committed and has invite slots', () => {
    render(experience('crowdfund', 500n * 1_000_000n, [inviteSection(0, 3)]))
    expect(inviteCard()).toBeTruthy()
    expect(participateCard()).toBeNull()
  })

  it('keeps the Participate card for an invited wallet that has not committed yet', () => {
    render(experience('crowdfund', 0n, [inviteSection(0, 3)]))
    expect(participateCard()).toBeTruthy()
    expect(inviteCard()).toBeNull()
  })

  it('keeps the Participate card for a committed wallet with no invite slots', () => {
    // Hop-2 is the last hop — its participants cannot invite further.
    render(experience('crowdfund', 500n * 1_000_000n, [inviteSection(2, 0)]))
    expect(participateCard()).toBeTruthy()
    expect(inviteCard()).toBeNull()
  })

  it('shows neither card once the commit window has closed', () => {
    render(experience('crowdfund', 500n * 1_000_000n, [inviteSection(0, 3)], false))
    expect(participateCard()).toBeNull()
    expect(inviteCard()).toBeNull()
  })

  it('keeps the same invite card mounted when switching to Your position', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(experience('crowdfund', 500n * 1_000_000n, [inviteSection(0, 3)]))
      const card = inviteCard()
      expect(card).toBeTruthy()
      rerender(experience('myposition', 500n * 1_000_000n, [inviteSection(0, 3)]))
      act(() => {
        vi.runAllTimers()
      })
      // Same DOM node — a single card instance, so in-progress invite state survives the switch.
      expect(inviteCard()).toBe(card)
    } finally {
      vi.useRealTimers()
    }
  })
})
