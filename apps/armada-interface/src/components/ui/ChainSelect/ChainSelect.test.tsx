// ABOUTME: Tests for ChainSelect — styled popover trigger + listbox, fires onChange with the chainId, honors custom chains list.
// ABOUTME: Default-chains path is exercised via the network.ts local fixture (Anvil hub + 2 clients).

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChainSelect } from './ChainSelect'
import { useMobileLayout } from '@/hooks/useMobileLayout'

// Default desktop (inline popover); the mobile test overrides to exercise the BottomSheet path.
vi.mock('@/hooks/useMobileLayout', () => ({ useMobileLayout: vi.fn(() => false) }))

const MAINNET = { chainId: 1, domain: 0, name: 'Mainnet', rpcUrls: ['x'] as const }
const OPTIMISM = { chainId: 10, domain: 2, name: 'Optimism', rpcUrls: ['y'] as const }

describe('<ChainSelect>', () => {
  it('renders all configured chains by default once opened', () => {
    render(<ChainSelect value={31337} onChange={() => {}} label="From chain" />)
    fireEvent.click(screen.getByLabelText('From chain'))
    // Local mode: hub 31337 + clientA 31338 + clientB 31339
    expect(screen.getByRole('option', { name: /Anvil Hub/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Anvil Client A/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Anvil Client B/ })).toBeInTheDocument()
  })

  it('honors the chains prop for a restricted list', () => {
    render(<ChainSelect value={1} onChange={() => {}} chains={[MAINNET, OPTIMISM]} label="From chain" />)
    fireEvent.click(screen.getByLabelText('From chain'))
    expect(screen.getByRole('option', { name: 'Mainnet' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Optimism' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Anvil/ })).toBeNull()
  })

  it('fires onChange with the numeric chainId when an option is picked', () => {
    const onChange = vi.fn()
    render(<ChainSelect value={31337} onChange={onChange} label="From chain" />)
    fireEvent.click(screen.getByLabelText('From chain'))
    fireEvent.click(screen.getByRole('option', { name: /Anvil Client A/ }))
    expect(onChange).toHaveBeenCalledWith(31338)
  })

  it('shows a non-interactive "more chains soon" notice below the chains (desktop)', () => {
    render(<ChainSelect value={31337} onChange={() => {}} label="From chain" />)
    fireEvent.click(screen.getByLabelText('From chain'))
    const notice = screen.getByText('More chains supported soon')
    expect(notice).toBeInTheDocument()
    // Not part of the selectable set: not an option, not a button.
    expect(notice).not.toHaveAttribute('role', 'option')
    expect(notice.closest('button')).toBeNull()
  })

  it('shows the notice in the mobile bottom sheet too', () => {
    vi.mocked(useMobileLayout).mockReturnValue(true)
    render(<ChainSelect value={31337} onChange={() => {}} label="From chain" />)
    fireEvent.click(screen.getByLabelText('From chain'))
    expect(screen.getByText('More chains supported soon')).toBeInTheDocument()
    vi.mocked(useMobileLayout).mockReturnValue(false)
  })

  it('collapses to a static, non-interactive trigger with a single chain', () => {
    render(<ChainSelect value={1} onChange={() => {}} chains={[MAINNET]} label="From chain" />)
    // Only one chain → nothing to pick → no trigger button, just the label shown statically.
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('From chain')).toHaveTextContent('Mainnet')
  })

  it('respects disabled — no interactive trigger', () => {
    render(<ChainSelect value={31337} onChange={() => {}} label="From chain" disabled />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByLabelText('From chain')).toBeInTheDocument()
  })

  it('on mobile, the trigger targets a dialog and options open in the bottom sheet', () => {
    vi.mocked(useMobileLayout).mockReturnValue(true)
    const onChange = vi.fn()
    render(<ChainSelect value={31337} onChange={onChange} label="From chain" />)
    const trigger = screen.getByLabelText('From chain')
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /Anvil Client A/ }))
    expect(onChange).toHaveBeenCalledWith(31338)
    vi.mocked(useMobileLayout).mockReturnValue(false)
  })
})
