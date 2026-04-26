// ABOUTME: Regression tests for shared checkout stepper controls.
// ABOUTME: Ensures footer callbacks receive semantic actions, not browser events.
// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StepFooter } from './Stepper.js'

describe('StepFooter', () => {
  it('does not forward click events into the primary action callback', () => {
    const onNext = vi.fn()

    render(<StepFooter onNext={onNext} nextLabel="Confirm transaction" />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm transaction' }))

    expect(onNext).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledWith()
  })
})
