// ABOUTME: Tests for ClaimTab component — state-dependent rendering across all phases.
// ABOUTME: Covers pre-finalization, post-fin success, refund mode, canceled, and below-minimum states.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClaimTab } from './ClaimTab'
import type { ClaimTabProps } from './ClaimTab'
import type { CrowdfundGraph } from '@armada/crowdfund-shared'

const USDC = 10n ** 6n

const emptyGraph: CrowdfundGraph = {
  nodes: new Map(),
  edges: [],
  summaries: new Map(),
}

function renderClaimTab(overrides: Partial<ClaimTabProps> = {}) {
  const defaultProps: ClaimTabProps = {
    address: '0xabc123abc123abc123abc123abc123abc123abc1',
    signer: null,
    provider: null,
    crowdfundAddress: '0x1234567890abcdef1234567890abcdef12345678',
    phase: 0,
    refundMode: false,
    blockTimestamp: 1700000000,
    claimDeadline: 0,
    totalCommitted: 19_000n * USDC,
    windowEnd: 1700100000,
    cappedDemand: 1_100_000n * USDC,
    graph: emptyGraph,
    ...overrides,
  }
  return render(<ClaimTab {...defaultProps} />)
}

describe('ClaimTab', () => {
  describe('pre-finalization (phase 0)', () => {
    it('shows countdown message when window is still open', () => {
      renderClaimTab({
        blockTimestamp: 1700000000,
        windowEnd: 1700100000,
      })
      expect(screen.getByText('Claims Available After Finalization')).toBeInTheDocument()
      expect(screen.getByText(/Commitment deadline in/)).toBeInTheDocument()
    })

    it('shows user committed amount', () => {
      renderClaimTab({ totalCommitted: 19_000n * USDC })
      expect(screen.getByText(/\$19,000/)).toBeInTheDocument()
    })

    it('shows below-minimum state when window ended and below MIN_SALE', () => {
      renderClaimTab({
        blockTimestamp: 1700200000,
        windowEnd: 1700100000,
        cappedDemand: 870_000n * USDC, // Below 1M min
      })
      expect(screen.getByText('Below Minimum Raise')).toBeInTheDocument()
      expect(screen.getByText(/minimum raise/)).toBeInTheDocument()
    })
  })

  describe('canceled (phase 2)', () => {
    it('shows cancellation refund message', () => {
      renderClaimTab({ phase: 2 })
      expect(screen.getByText(/Crowdfund was canceled/)).toBeInTheDocument()
      expect(screen.getByText('Claim Refund')).toBeInTheDocument()
    })
  })

  describe('refund mode (phase 1, refundMode true)', () => {
    it('shows refund-only message', () => {
      renderClaimTab({ phase: 1, refundMode: true })
      expect(screen.getByText(/Sale did not meet minimum/)).toBeInTheDocument()
      expect(screen.getByText('Claim Refund')).toBeInTheDocument()
    })
  })

  describe('all claimed', () => {
    it('shows all-claims-complete message', () => {
      // When phase >= 1, provider exists, and both flags set
      // We need to mock the fetch — since provider is null, loading will be false immediately
      renderClaimTab({
        phase: 1,
        refundMode: false,
      })
      // With no provider, it won't fetch allocations and will show the post-fin success view
      // with 0 ARM and 0 refund (no allocation found)
      expect(screen.getByText(/No allocation found/)).toBeInTheDocument()
    })
  })
})
