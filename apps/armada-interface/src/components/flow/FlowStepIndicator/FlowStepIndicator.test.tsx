// ABOUTME: Tests for FlowStepIndicator — segment count, lavender fill, confirmed green, step label.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FlowStepIndicator } from './FlowStepIndicator'

describe('<FlowStepIndicator>', () => {
  it('renders the correct number of segments', () => {
    const { container } = render(<FlowStepIndicator currentStep={2} totalSteps={3} />)
    expect(container.querySelectorAll('[class*="segment"]').length).toBe(3)
  })

  it('fills segments up to currentStep with active (lavender) in default status', () => {
    const { container } = render(<FlowStepIndicator currentStep={2} totalSteps={3} />)
    const segments = Array.from(container.querySelectorAll('[class*="segment"]'))
    const active = segments.filter(s => s.className.includes('active'))
    expect(active.length).toBe(2)
  })

  it('renders all segments green when status is confirmed', () => {
    const { container } = render(
      <FlowStepIndicator currentStep={3} totalSteps={3} status="confirmed" />,
    )
    const segments = Array.from(container.querySelectorAll('[class*="segment"]'))
    expect(segments.every(s => s.className.includes('confirmed'))).toBe(true)
  })

  it('renders the step count label', () => {
    render(<FlowStepIndicator currentStep={3} totalSteps={3} />)
    expect(screen.getByText('STEP 3 OF 3')).toBeInTheDocument()
  })

  it('shows final step count when confirmed', () => {
    render(<FlowStepIndicator currentStep={3} totalSteps={3} status="confirmed" />)
    expect(screen.getByText('STEP 3 OF 3')).toBeInTheDocument()
  })

  it('exposes role="progressbar" with aria values', () => {
    render(<FlowStepIndicator currentStep={2} totalSteps={3} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemin', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '3')
  })
})
