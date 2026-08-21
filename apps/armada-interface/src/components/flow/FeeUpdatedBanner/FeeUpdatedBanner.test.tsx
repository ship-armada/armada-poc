// ABOUTME: Render test for FeeUpdatedBanner — the review-step fee-changed callout.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeeUpdatedBanner } from './FeeUpdatedBanner'

describe('FeeUpdatedBanner', () => {
  it('renders the fee-changed callout with the review prompt', () => {
    render(<FeeUpdatedBanner />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(/network fee changed/i)
    expect(banner).toHaveTextContent(/review the updated amount/i)
  })

  it('appends the new fee when provided', () => {
    render(<FeeUpdatedBanner feeLabel="$0.12" />)
    expect(screen.getByRole('status')).toHaveTextContent(/changed to \$0\.12/i)
  })
})
