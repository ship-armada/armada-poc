// ABOUTME: Tests for ErrorStep — category-aware title/body from `error.code`, explorer link when txHash is supplied, Try Again gating, View Details optional, fallback to `message` when no typed error.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorStep } from './ErrorStep'

describe('<ErrorStep>', () => {
  it('renders the default fallback title when no error or message is supplied', () => {
    render(<ErrorStep />)
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  })

  it('uses category-specific copy for POLL_TIMEOUT', () => {
    // Distinct from "Failed" — POLL_TIMEOUT means the tx may still complete on chain. We need
    // the user to understand the difference so they don't assume their funds are lost.
    render(<ErrorStep error={{ code: 'POLL_TIMEOUT', message: 'raw lib msg' }} />)
    expect(screen.getByText('Lost track of your transaction')).toBeInTheDocument()
    expect(screen.getByText(/may still complete/i)).toBeInTheDocument()
  })

  it('uses category-specific copy for DISMISSED', () => {
    // The user explicitly stopped tracking a post-broadcast tx. Different copy from CANCELLED
    // (which means "no tx was sent at all").
    render(<ErrorStep error={{ code: 'DISMISSED', message: '' }} />)
    expect(screen.getByText('Stopped tracking')).toBeInTheDocument()
  })

  it('uses category-specific copy for TX_REVERTED', () => {
    render(<ErrorStep error={{ code: 'TX_REVERTED', message: 'execution reverted' }} />)
    expect(screen.getByText('Transaction failed on chain')).toBeInTheDocument()
  })

  it('uses pre-flight-specific copy for PRE_FLIGHT_REVERT and surfaces the actual revert reason', () => {
    // WHY: distinct from TX_REVERTED. The user's wallet was never prompted and no funds
    // moved. The title must convey "nothing was sent" so the user doesn't believe they
    // paid gas. The body must surface the actual contract reason (from error.message) so
    // the user can act on it (e.g. retry to re-generate against a fresh merkle root).
    render(
      <ErrorStep
        error={{
          code: 'PRE_FLIGHT_REVERT',
          message: 'execution reverted: MerkleRootInvalid()',
        }}
      />,
    )
    expect(screen.getByText('Pre-flight check failed — nothing was sent')).toBeInTheDocument()
    expect(screen.getByText(/MerkleRootInvalid/)).toBeInTheDocument()
  })

  it('uses category-specific copy for USER_REJECTED', () => {
    render(<ErrorStep error={{ code: 'USER_REJECTED', message: 'user denied' }} />)
    expect(screen.getByText('Action declined')).toBeInTheDocument()
  })

  it('renders the raw error.message when the code is OTHER and no body is preset', () => {
    // OTHER has no category-specific body — fall through to the raw message so we don't hide
    // a useful error string from the user (or developer) in production.
    render(<ErrorStep error={{ code: 'OTHER', message: 'gas estimation failed: insufficient funds' }} />)
    expect(screen.getByText(/insufficient funds/)).toBeInTheDocument()
  })

  it('renders the fallback `message` prop when no typed error is supplied (submit-time path)', () => {
    render(<ErrorStep message="Relayer returned 502 Bad Gateway." />)
    expect(screen.getByText('Relayer returned 502 Bad Gateway.')).toBeInTheDocument()
  })

  it('renders an explorer link when explorerUrl is supplied', () => {
    render(
      <ErrorStep
        error={{ code: 'POLL_TIMEOUT', message: '', txHash: '0xabc' }}
        explorerUrl="https://sepolia.etherscan.io/tx/0xabc"
      />,
    )
    const link = screen.getByRole('link', { name: /View on block explorer/i })
    expect(link).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0xabc')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('omits the explorer link when explorerUrl is undefined', () => {
    // POLL_TIMEOUT category itself doesn't render the link — only when the modal supplies the
    // composed URL. Records without a known explorerUrl (e.g. local Anvil) should not show a
    // broken anchor.
    render(<ErrorStep error={{ code: 'POLL_TIMEOUT', message: '' }} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('disables Try Again when onRetry is omitted', () => {
    render(<ErrorStep />)
    expect(screen.getByRole('button', { name: /Try again/ })).toBeDisabled()
  })

  it('enables Try Again and fires onRetry on click', () => {
    const onRetry = vi.fn()
    render(<ErrorStep onRetry={onRetry} />)
    const btn = screen.getByRole('button', { name: /Try again/ })
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('defaults the primary button label to "Try again"', () => {
    render(<ErrorStep onRetry={() => {}} />)
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })

  it('renders a custom primaryLabel (S-M3 "Start over" for non-retryable failures)', () => {
    const onRetry = vi.fn()
    render(<ErrorStep onRetry={onRetry} primaryLabel="Start over" />)
    expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
    const btn = screen.getByRole('button', { name: /Start over/ })
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('omits the View Details button when onViewDetails is undefined', () => {
    render(<ErrorStep onRetry={() => {}} />)
    expect(screen.queryByRole('button', { name: /View details/ })).toBeNull()
  })

  it('renders the View Details button when onViewDetails is provided', () => {
    const onViewDetails = vi.fn()
    render(<ErrorStep onRetry={() => {}} onViewDetails={onViewDetails} />)
    fireEvent.click(screen.getByRole('button', { name: /View details/ }))
    expect(onViewDetails).toHaveBeenCalledTimes(1)
  })
})
