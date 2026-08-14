// ABOUTME: Tests for ShieldCompleteStep — renders the confirmed headline, the deposited amount, and dispatches onDone.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ShieldCompleteStep } from './ShieldCompleteStep'

describe('<ShieldCompleteStep>', () => {
  it('renders the headline and the net amount in the coin+amount block', () => {
    render(<ShieldCompleteStep netAmount={250_500_000n} onDone={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Deposit confirmed' })).toBeInTheDocument()
    expect(screen.getByText('250.50')).toBeInTheDocument()
  })

  it('fires onDone when the Done CTA is clicked', () => {
    const onDone = vi.fn()
    render(<ShieldCompleteStep netAmount={1_000_000n} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: /Done/ }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
