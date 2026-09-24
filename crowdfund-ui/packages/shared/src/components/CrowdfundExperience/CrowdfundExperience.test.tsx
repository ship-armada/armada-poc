// ABOUTME: Tests for the My Position card header CTA in CrowdfundExperience.
// ABOUTME: "Commit again" only when the connected wallet has committed; otherwise "Participate".
// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  CrowdfundExperience,
  type CrowdfundExperienceMyPositionData,
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

describe('CrowdfundExperience My Position header CTA', () => {
  it('shows "Participate" for an invited wallet that has not committed yet', () => {
    renderMyPosition(readyPosition(0n))
    const card = within(screen.getByRole('region', { name: 'Your position' }))
    expect(card.getByRole('button', { name: /Participate/ })).toBeTruthy()
    expect(card.queryByRole('button', { name: /Commit again/ })).toBeNull()
  })

  it('shows "Commit again" once the wallet has committed', () => {
    renderMyPosition(readyPosition(500n * 1_000_000n))
    const card = within(screen.getByRole('region', { name: 'Your position' }))
    expect(card.getByRole('button', { name: /Commit again/ })).toBeTruthy()
    expect(card.queryByRole('button', { name: /Participate/ })).toBeNull()
  })
})
