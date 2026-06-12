// ABOUTME: Tests for Step5Confirmation — the "already fully committed" (maxedOut) copy variant.
// ABOUTME: Distinct headline/subline + View-position action vs the first-time confirmation.
// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Step5Confirmation from './Step5Confirmation.js'

describe('Step5Confirmation', () => {
  it('shows the already-fully-committed copy + Invite/View actions when maxedOut', () => {
    render(
      <Step5Confirmation
        maxedOut
        onInvite={vi.fn()}
        onViewPosition={vi.fn()}
        amount={0}
        estimatedArm={5000}
        totalCommittedUsdc={4000}
      />,
    )
    expect(screen.getByText("You're fully committed.")).toBeTruthy()
    expect(screen.getByText(/committed the maximum/i)).toBeTruthy()
    expect(screen.getByText(/\$4,000/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Invite participants' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View your position' })).toBeTruthy()
  })

  it('uses the first-time copy when not maxed out', () => {
    render(<Step5Confirmation onInvite={vi.fn()} amount={1000} estimatedArm={1000} />)
    expect(screen.getByText("You're in.")).toBeTruthy()
    expect(screen.queryByText(/committed the maximum/i)).toBeNull()
  })
})
