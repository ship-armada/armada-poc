// ABOUTME: Tests for SlotCard's wrong-network state on an empty invite slot.
// ABOUTME: On the wrong chain the invite/create-link buttons are replaced by a single "Switch network" action.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import SlotCard, { type SlotData } from './SlotCard'

const emptySlot: SlotData = { id: 1, status: 'empty' }

const baseHandlers = {
  onGenerateLink: vi.fn().mockResolvedValue(undefined),
  onCopy: vi.fn(),
  onRevoke: vi.fn(),
  onInviteOnchain: vi.fn().mockResolvedValue(undefined),
}

describe('SlotCard wrong-network state', () => {
  it('replaces the invite buttons with a "Switch network" action on the wrong chain', () => {
    const onSwitchNetwork = vi.fn()
    render(
      <SlotCard slot={emptySlot} {...baseHandlers} isWrongNetwork onSwitchNetwork={onSwitchNetwork} />,
    )

    expect(screen.queryByRole('button', { name: 'Invite onchain' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }))
    expect(onSwitchNetwork).toHaveBeenCalled()
  })

  it('shows the normal invite buttons when on the right chain', () => {
    render(<SlotCard slot={emptySlot} {...baseHandlers} isWrongNetwork={false} />)

    expect(screen.getByRole('button', { name: 'Invite onchain' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Switch network' })).toBeNull()
  })
})
