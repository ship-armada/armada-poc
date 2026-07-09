// ABOUTME: Tests for NonDeterministicSignerScreen — renders compatibility lists + routes the two CTAs (use-recovery / try-different-wallet) for both error reasons.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NonDeterministicSignerScreen } from './NonDeterministicSignerScreen'

describe('<NonDeterministicSignerScreen>', () => {
  it('renders the first-sign-mismatch headline + CTAs', () => {
    const onUseRecovery = vi.fn()
    const onTryDifferentWallet = vi.fn()
    render(
      <NonDeterministicSignerScreen
        reason="first-sign-mismatch"
        onUseRecovery={onUseRecovery}
        onTryDifferentWallet={onTryDifferentWallet}
      />,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading')).toHaveTextContent(/can't unlock by signing/i)
    expect(screen.getByText(/randomize signatures/i)).toBeInTheDocument()
  })

  it('renders the cached-checksum-mismatch headline for returning sign-ins', () => {
    render(
      <NonDeterministicSignerScreen
        reason="cached-checksum-mismatch"
        onUseRecovery={vi.fn()}
        onTryDifferentWallet={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading')).toHaveTextContent(/different identity/i)
    expect(screen.getByText(/changed underlying accounts/i)).toBeInTheDocument()
  })

  it('includes the supported + unsupported wallet compatibility lists', () => {
    render(
      <NonDeterministicSignerScreen
        reason="first-sign-mismatch"
        onUseRecovery={vi.fn()}
        onTryDifferentWallet={vi.fn()}
      />,
    )
    expect(screen.getByText('MetaMask')).toBeInTheDocument()
    expect(screen.getByText('Rabby')).toBeInTheDocument()
    expect(screen.getByText('Frame')).toBeInTheDocument()
    expect(screen.getByText('Safe / Gnosis Safe')).toBeInTheDocument()
    expect(screen.getByText(/ERC-4337/)).toBeInTheDocument()
  })

  it('fires onUseRecovery when the primary CTA is clicked', () => {
    const onUseRecovery = vi.fn()
    render(
      <NonDeterministicSignerScreen
        reason="first-sign-mismatch"
        onUseRecovery={onUseRecovery}
        onTryDifferentWallet={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /backup file or recovery secret/i }))
    expect(onUseRecovery).toHaveBeenCalledTimes(1)
  })

  it('fires onTryDifferentWallet when the secondary CTA is clicked', () => {
    const onTryDifferentWallet = vi.fn()
    render(
      <NonDeterministicSignerScreen
        reason="first-sign-mismatch"
        onUseRecovery={vi.fn()}
        onTryDifferentWallet={onTryDifferentWallet}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /try a different wallet/i }))
    expect(onTryDifferentWallet).toHaveBeenCalledTimes(1)
  })
})
