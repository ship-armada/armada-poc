// ABOUTME: Tests for WelcomeStep — renders headline + body + Create CTA, click fires onContinue.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WelcomeStep } from './WelcomeStep'

describe('<WelcomeStep>', () => {
  it('renders the headline', () => {
    render(<WelcomeStep onContinue={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Create your private USDC account' })).toBeInTheDocument()
  })

  it('fires onContinue when the Create CTA is clicked', () => {
    const onContinue = vi.fn()
    render(<WelcomeStep onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: /Create account/ }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('hides the Restore secondary CTA when onRestore is not supplied', () => {
    render(<WelcomeStep onContinue={() => {}} />)
    expect(screen.queryByRole('button', { name: /I have a backup/i })).toBeNull()
  })

  it('renders the Restore CTA when onRestore is supplied and fires it on click', () => {
    // Covers the "new device / cleared storage but I already have a backup" path: App.tsx
    // unconditionally supplies onRestore in onboarding mode, so this CTA is the escape hatch
    // that prevents a returning-user-on-a-new-device from being forced into creating a fresh
    // (orphaning) account.
    const onRestore = vi.fn()
    render(<WelcomeStep onContinue={() => {}} onRestore={onRestore} />)
    fireEvent.click(screen.getByRole('button', { name: /I have a backup/i }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })
})
