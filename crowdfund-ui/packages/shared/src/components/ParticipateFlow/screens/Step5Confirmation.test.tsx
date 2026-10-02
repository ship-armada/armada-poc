// ABOUTME: Tests for Step5Confirmation — the "already fully committed" (maxedOut) copy variant.
// ABOUTME: Distinct headline/subline + View-position action vs the first-time confirmation.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Step5Confirmation from './Step5Confirmation.js'

describe('Step5Confirmation', () => {
  it('shows the already-fully-committed copy + Invite/View actions when maxedOut', () => {
    render(
      <Step5Confirmation
        maxedOut
        onInvite={vi.fn()}
        onViewPosition={vi.fn()}
        amount={0}
        estimatedArm={5000}
        totalCommittedUsdc={4000}
      />,
    )
    expect(screen.getByText('Already committed')).toBeTruthy()
    expect(screen.getByText(/committed the maximum/i)).toBeTruthy()
    expect(screen.getByText(/\$4,000/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Whitelist a friend' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View your position' })).toBeTruthy()
  })

  it('uses the first-time copy when not maxed out', () => {
    render(<Step5Confirmation onInvite={vi.fn()} amount={1000} estimatedArm={1000} />)
    expect(screen.getByText('Commit successful')).toBeTruthy()
    expect(screen.queryByText(/committed the maximum/i)).toBeNull()
  })

  it('folds the tx hash into the summary table as an explorer link', () => {
    const txHash = '0x9f2e1d0c…a9988776'
    render(
      <Step5Confirmation
        amount={1000}
        estimatedArm={1000}
        txHash={txHash}
        explorerBaseUrl="https://sepolia.etherscan.io"
      />,
    )
    const link = screen.getByRole('link', { name: /0x9f2e/ })
    expect(link.getAttribute('href')).toBe(`https://sepolia.etherscan.io/tx/${txHash}`)
    expect(screen.getByRole('navigation', { name: 'Useful links' })).toBeTruthy()
  })

  it('never invents a window deadline when no countdown is passed', () => {
    render(<Step5Confirmation amount={1000} estimatedArm={1000} />)
    fireEvent.click(screen.getByRole('button', { name: 'While the window is open' }))
    expect(screen.queryByText(/closes in/)).toBeNull()
    expect(screen.getByText(/The commitment window is closing\./)).toBeTruthy()
  })

  it('offers Max out inside the card (the mobile placement) when an option is passed', () => {
    render(
      <Step5Confirmation
        amount={1000}
        estimatedArm={1000}
        maxOut={{ ceilingUsd: 8000, newCommitUsd: 7000, inviteCount: 2, onMaxOut: vi.fn() }}
      />,
    )
    const banner = screen.getByRole('region', { name: 'Commit the maximum' })
    expect(banner.className).toMatch(/inShell/)
    expect(screen.getByRole('button', { name: 'Max out' })).toBeTruthy()
  })

  it('shows no Max out banner without an option', () => {
    render(<Step5Confirmation amount={1000} estimatedArm={1000} />)
    expect(screen.queryByRole('region', { name: 'Commit the maximum' })).toBeNull()
  })

  it('omits the tx hash row when no hash is provided', () => {
    render(<Step5Confirmation amount={1000} estimatedArm={1000} />)
    expect(screen.queryByText('Tx hash')).toBeNull()
  })

  it('promotes View your position and shows Back to crowdfund when canInvite is false', () => {
    render(
      <Step5Confirmation
        canInvite={false}
        onViewPosition={vi.fn()}
        onBackToCrowdfund={vi.fn()}
        amount={1000}
        estimatedArm={1000}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Whitelist a friend' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to crowdfund' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View your position' })).toBeTruthy()
  })
})
