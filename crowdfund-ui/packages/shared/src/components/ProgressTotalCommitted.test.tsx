// ABOUTME: Tests the @armada/ui Progress card's "Total Committed" amount — exact dollars, not $Nk / $N.NM.
// ABOUTME: Covers the static label and the end state of the count-up animation.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Progress } from '@armada/ui'

describe('Progress total committed', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the exact amount rounded to the nearest dollar', () => {
    render(<Progress committedAmount={11_416.8} animateOnMount={false} />)
    expect(screen.getByText('$11,417')).toBeTruthy()
  })

  it('does not abbreviate millions', () => {
    render(<Progress committedAmount={1_234_567.4} animateOnMount={false} />)
    expect(screen.getByText('$1,234,567')).toBeTruthy()
  })

  it('shows $0 with nothing committed', () => {
    render(<Progress committedAmount={0} animateOnMount={false} />)
    expect(screen.getByText('$0')).toBeTruthy()
  })

  it('lands the count-up animation on the exact amount', () => {
    vi.useFakeTimers()
    render(<Progress committedAmount={11_416.8} />)
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByText('$11,417')).toBeTruthy()
  })
})
