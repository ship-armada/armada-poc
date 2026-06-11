// ABOUTME: Regression tests for the Step4Approve showcase gate.
// ABOUTME: A real flow (no showcase) must never auto-complete into a fake success.
// @vitest-environment jsdom

import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import Step4Approve from './Step4Approve.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('Step4Approve showcase gate', () => {
  it('shows a neutral preparing state and never auto-calls onDone without showcase', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<Step4Approve onDone={onDone} />)

    expect(screen.getAllByText('Preparing transaction…').length).toBeGreaterThan(0)

    // Advance well past the canned animation window — onDone must NOT fire.
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('runs the canned animation and calls onDone in showcase mode', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<Step4Approve onDone={onDone} showcase amount={1000} />)

    act(() => {
      vi.advanceTimersByTime(4_500)
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('renders controlled tx rows without auto-completing', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(
      <Step4Approve
        onDone={onDone}
        txs={[{ label: 'Commit participation', status: 'loading' }]}
      />,
    )
    expect(screen.getByText('Commit participation')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onDone).not.toHaveBeenCalled()
  })
})
