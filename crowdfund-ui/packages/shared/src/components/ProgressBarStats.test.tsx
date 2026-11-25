// ABOUTME: Tests the @armada/ui Progress card's bar stats: FUNDED and LEFT measure progress toward the funding goal.
// ABOUTME: The bar scales to the sale maximum, FUNDED can pass 100%, and the goal tick carries no label.
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Progress } from '@armada/ui'

// Relaunch figures: a $750K goal on a $1.8M maximum.
const GOAL = 750_000
const MAX = 1_800_000

describe('Progress bar stats', () => {
  afterEach(cleanup)

  // WHY: the team presents the $750K goal as "100% funded"; FUNDED and LEFT measure toward it.
  it('measures FUNDED and LEFT against the goal', () => {
    render(<Progress committedAmount={450_000} goalAmount={GOAL} maxAmount={MAX} animateOnMount={false} />)
    expect(screen.getByText('60%')).toBeTruthy()
    expect(screen.getByText('$300K')).toBeTruthy()
  })

  // WHY: commitments can run past the goal up to the sale maximum, so FUNDED is not capped at 100%
  // (240% at a full $1.8M), and LEFT is hidden once the goal is met: "$0 left" while commits are
  // still open would read as the sale being closed.
  it('lets FUNDED pass 100% and hides LEFT once the goal is met', () => {
    render(<Progress committedAmount={1_800_000} goalAmount={GOAL} maxAmount={MAX} animateOnMount={false} />)
    expect(screen.getByText('240%')).toBeTruthy()
    expect(screen.queryByText('LEFT')).toBeNull()
  })

  // WHY: LEFT reads like the rest of the UI's headline amounts ("$750K", "$1.2M"), not "$750k".
  it('shows LEFT in short dollar form', () => {
    render(<Progress committedAmount={0} goalAmount={GOAL} maxAmount={MAX} animateOnMount={false} />)
    expect(screen.getByText('0%')).toBeTruthy()
    expect(screen.getByText('$750K')).toBeTruthy()
  })

  // WHY: the goal is marked by the tick on the bar alone; a floating label there overlapped the
  // FUNDED / LEFT stats on narrow screens, and the minimum is not shown on this card at all.
  it('shows no goal or minimum label', () => {
    render(<Progress committedAmount={0} goalAmount={GOAL} maxAmount={MAX} animateOnMount={false} />)
    expect(screen.queryByText(/GOAL|MIN FUND/)).toBeNull()
  })
})
