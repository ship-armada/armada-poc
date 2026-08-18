// ABOUTME: Tests for WalletMenu — the pill opens the side panel; copy / disconnect / deposit / hide-balance actions wire through; explorer disables without a URL.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WalletMenu, type WalletMenuProps } from './WalletMenu'

const FULL = '0x1234567890abcdef1234567890abcdef12345678'
const DISPLAY = '0x1234…5678'

function setup(extra?: Partial<WalletMenuProps>) {
  const props: WalletMenuProps = {
    displayAddress: DISPLAY,
    fullAddress: FULL,
    walletProvider: 'MetaMask',
    chainId: 11155111,
    usdcBalance: 1234.5,
    networkLabel: 'Ethereum Sepolia',
    explorerUrl: `https://sepolia.etherscan.io/address/${FULL}`,
    balanceHidden: false,
    onBalanceHiddenChange: vi.fn(),
    onDisconnect: vi.fn(),
    onDeposit: vi.fn(),
    ...extra,
  }
  render(<WalletMenu {...props} />)
  return props
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(DISPLAY) }))
}

describe('<WalletMenu>', () => {
  it('renders the pill with the truncated address', () => {
    setup()
    expect(screen.getByRole('button', { name: new RegExp(DISPLAY) })).toBeInTheDocument()
  })

  it('opens the side panel on pill click', () => {
    setup()
    expect(screen.queryByRole('dialog', { name: 'Wallet' })).toBeNull()
    openPanel()
    expect(screen.getByRole('dialog', { name: 'Wallet' })).toBeInTheDocument()
  })

  it('copies the full address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Copy wallet address' }))
    expect(writeText).toHaveBeenCalledWith(FULL)
    // Await the post-copy state flip so the async setState settles inside act (pristine output).
    expect(await screen.findByRole('button', { name: 'Address copied' })).toBeInTheDocument()
  })

  it('fires onDisconnect', () => {
    const props = setup()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect wallet' }))
    expect(props.onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('fires onDeposit', () => {
    const props = setup()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'DEPOSIT' }))
    expect(props.onDeposit).toHaveBeenCalledTimes(1)
  })

  it('requests a balance-visibility change (controlled, shared app-wide)', () => {
    const props = setup()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Hide balance' }))
    expect(props.onBalanceHiddenChange).toHaveBeenCalledWith(true)
  })

  it('reflects the hidden state from props', () => {
    setup({ balanceHidden: true })
    openPanel()
    expect(screen.getByRole('button', { name: 'Show balance' })).toBeInTheDocument()
  })

  it('disables the explorer action when no URL is available', () => {
    setup({ explorerUrl: undefined })
    openPanel()
    expect(screen.getByRole('button', { name: 'View wallet on explorer' })).toBeDisabled()
  })
})
