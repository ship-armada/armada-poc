// ABOUTME: Tests for stale/indexer health warning banner rendering.
// ABOUTME: Verifies degraded indexer states are surfaced to users before generic query stale state.
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StaleDataBanner } from './StaleDataBanner.js'

describe('StaleDataBanner', () => {
  it('renders indexer stale warning when health is not healthy', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StaleDataBanner
          indexerHealth={{
            status: 'stale',
            chainHead: 120,
            confirmedHead: 110,
            ingestedCursor: 110,
            verifiedCursor: 100,
            lagBlocks: 10,
            lastIngestedAt: null,
            lastVerifiedAt: null,
            lastReconciledAt: null,
            hasGaps: false,
            gapRanges: [],
            lastError: null,
            latestSnapshotHash: null,
            latestStaticSnapshotUrl: null,
          }}
        />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Indexer is catching up')).toBeTruthy()
    expect(screen.getByText(/verified data through block 100/)).toBeTruthy()
  })
})
