// ABOUTME: Tests for ParticipantTable component — columns, filters, inviter labels.
// ABOUTME: Verifies inviter display labels and phase-conditional column visibility.

import { render, screen } from '@testing-library/react'
import { ParticipantTable } from './ParticipantTable'
import type { ParticipantRow } from '@/hooks/useParticipants'

const LT_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADDR_A = '0x1111111111111111111111111111111111111111'
const ADDR_B = '0x2222222222222222222222222222222222222222'

function makeRow(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    address: ADDR_A,
    hop: 0,
    invitedBy: [],
    invitesReceived: 1,
    effectiveCap: 15000n * 10n ** 6n,
    committed: 5000n * 10n ** 6n,
    invitesUsed: 0,
    invitesTotal: 5,
    allocatedArm: null,
    refundUsdc: null,
    armClaimed: false,
    refundClaimed: false,
    ...overrides,
  }
}

describe('ParticipantTable', () => {
  it('renders participant addresses', () => {
    const rows = [makeRow()]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText(/0x1111\.\.\.1111/)).toBeInTheDocument()
  })

  it('shows "Armada" for hop-0 inviter', () => {
    const rows = [makeRow({ hop: 0, invitedBy: ['armada'] })]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText('Armada')).toBeInTheDocument()
  })

  it('shows "Launch Team" when inviter matches LT address', () => {
    const rows = [makeRow({ hop: 1, invitedBy: [LT_ADDR] })]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText('Launch Team')).toBeInTheDocument()
  })

  it('shows truncated address for regular inviter', () => {
    const rows = [makeRow({ hop: 1, invitedBy: [ADDR_B] })]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText(/0x2222\.\.\.2222/)).toBeInTheDocument()
  })

  it('hides ARM Allocated and Claimed columns before finalization', () => {
    const rows = [makeRow()]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.queryByText('ARM Allocated')).not.toBeInTheDocument()
    expect(screen.queryByText('Claimed')).not.toBeInTheDocument()
  })

  it('shows ARM Allocated, Refund, and Claimed columns post-finalization', () => {
    const rows = [makeRow({ allocatedArm: 5000n * 10n ** 18n, armClaimed: false, refundUsdc: 1000n * 10n ** 6n })]
    render(<ParticipantTable participants={rows} phase={1} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText('ARM Allocated')).toBeInTheDocument()
    // "Refund" appears as column header
    expect(screen.getByRole('columnheader', { name: /refund/i })).toBeInTheDocument()
    // "Claimed" appears as column header and filter option — use columnheader role
    expect(screen.getByRole('columnheader', { name: /claimed/i })).toBeInTheDocument()
  })

  it('shows dual claim indicator (ARM ✓/✗ Refund ✓/✗)', () => {
    const rows = [makeRow({
      allocatedArm: 5000n * 10n ** 18n,
      refundUsdc: 1000n * 10n ** 6n,
      armClaimed: true,
      refundClaimed: false,
    })]
    render(<ParticipantTable participants={rows} phase={1} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText(/ARM ✓/)).toBeInTheDocument()
    expect(screen.getByText(/Refund ✗/)).toBeInTheDocument()
  })

  it('shows view mode toggle', () => {
    const rows = [makeRow()]
    render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText('Per-Hop')).toBeInTheDocument()
    expect(screen.getByText('Per-Address')).toBeInTheDocument()
  })

  it('shows claim filter only post-finalization', () => {
    const rows = [makeRow()]
    const { rerender } = render(<ParticipantTable participants={rows} phase={0} launchTeamAddress={LT_ADDR} />)
    expect(screen.queryByText('All Claims')).not.toBeInTheDocument()

    rerender(<ParticipantTable participants={rows} phase={1} launchTeamAddress={LT_ADDR} />)
    expect(screen.getByText('All Claims')).toBeInTheDocument()
  })
})
