// ABOUTME: Render tests for AmountFieldWarning — the above-field alert tooltip for amount validation errors.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AmountFieldWarning } from './AmountFieldWarning'

describe('<AmountFieldWarning>', () => {
  it('shows the message as an alert above its children when visible', () => {
    render(
      <AmountFieldWarning id="warn" visible message="That's more than you can deposit">
        <input aria-label="Amount" />
      </AmountFieldWarning>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent("That's more than you can deposit")
    // The field it wraps is still rendered.
    expect(screen.getByLabelText('Amount')).toBeInTheDocument()
  })

  it('renders no alert when not visible', () => {
    render(
      <AmountFieldWarning id="warn" visible={false} message="hidden">
        <input aria-label="Amount" />
      </AmountFieldWarning>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Amount')).toBeInTheDocument()
  })
})
