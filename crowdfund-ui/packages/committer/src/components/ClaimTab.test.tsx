// ABOUTME: Tests for ClaimTab component — info states and stepper review/confirm flow.
// ABOUTME: Walks pre-finalization info, canceled, refund mode, and "no allocation" branches.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ClaimTab } from './ClaimTab'
import type { ClaimTabProps } from './ClaimTab'
import type { CrowdfundGraph } from '@armada/crowdfund-shared'

const USDC = 10n ** 6n

const emptyGraph: CrowdfundGraph = {
  nodes: new Map(),
  edges: [],
  summaries: new Map(),
  events: [],
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
      expect(screen.getByText('Claims open after finalization')).toBeInTheDocument()
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
      expect(screen.getByText('Below minimum raise')).toBeInTheDocument()
      // "minimum raise" appears in both the title and the body — assert the body copy
      expect(screen.getByText(/below the minimum raise/i)).toBeInTheDocument()
    })
  })

  describe('canceled (phase 2)', () => {
    it('routes into the refund stepper showing the cancellation message and refund total', () => {
      renderClaimTab({ phase: 2 })
      expect(screen.getByText(/crowdfund was cancelled/i)).toBeInTheDocument()
      expect(screen.getByText('Review your refund')).toBeInTheDocument()
      // totalCommitted is 19,000 USDC for the default render
      expect(screen.getAllByText(/\$19,000/).length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('refund mode (phase 1, refundMode true)', () => {
    it('routes into the refund stepper showing the refund-only message', () => {
      renderClaimTab({ phase: 1, refundMode: true })
      expect(screen.getByText(/did not meet the minimum raise/)).toBeInTheDocument()
      expect(screen.getByText('Review your refund')).toBeInTheDocument()
    })
  })

  describe('no allocation', () => {
    it('shows no-allocation empty state when post-finalization with zero allocation', () => {
      renderClaimTab({
        phase: 1,
        refundMode: false,
      })
      // With no provider, no allocation is fetched → 0 ARM + 0 refund → empty state.
      expect(screen.getByText(/No allocation found/)).toBeInTheDocument()
    })
  })
})
