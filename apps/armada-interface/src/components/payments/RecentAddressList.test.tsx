// ABOUTME: Tests for RecentAddressList — renders label + truncated address + relative time; row click fires onSelect; empty renders nothing.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RecentAddressList } from './RecentAddressList'
import type { RecentRecipient } from '@/lib/tx/recentRecipients'

const NOW = 1_000_000_000_000
const EVM_A = '0x1111111111111111111111111111111111111111'
const EVM_B = '0x2222222222222222222222222222222222222222'

const ITEMS: RecentRecipient[] = [
  { address: EVM_A, kind: 'unshield-local', destChainId: 31337, lastAt: NOW - 3 * 86_400_000 },
  { address: EVM_B, kind: 'unshield-xchain', destChainId: 84532, lastAt: NOW - 60_000 },
]

describe('<RecentAddressList>', () => {
  it('renders the label, a truncated address, and a relative time per item', () => {
    render(<RecentAddressList items={ITEMS} onSelect={vi.fn()} now={NOW} />)
    expect(screen.getByText('Recent address')).toBeInTheDocument()
    // Middle-truncated address (first 6 + "..." + last 4), not the full string.
    expect(screen.getByText('0x1111...1111')).toBeInTheDocument()
    expect(screen.getByText('3d ago')).toBeInTheDocument()
    expect(screen.getByText('1m ago')).toBeInTheDocument()
  })

  it('fires onSelect with the clicked item', () => {
    const onSelect = vi.fn()
    render(<RecentAddressList items={ITEMS} onSelect={onSelect} now={NOW} />)
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[0])
  })

  it('renders nothing when there are no recent addresses', () => {
    const { container } = render(<RecentAddressList items={[]} onSelect={vi.fn()} now={NOW} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Recent address')).toBeNull()
  })
})
