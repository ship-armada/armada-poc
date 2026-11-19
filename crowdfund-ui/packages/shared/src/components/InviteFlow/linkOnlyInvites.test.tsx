// ABOUTME: Tests for link-only invites (profiles with directInvites off, e.g. the relaunch): the method
// ABOUTME: picker, the hop focus hook and SlotCard must offer invite links only, never an on-chain invite.
// @vitest-environment jsdom

import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/inviteUx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/inviteUx')>()),
  DIRECT_INVITES_ENABLED: false,
}))

import { InviteMethodPicker } from './InviteMethodPicker'
import { useInviteHopFocus } from './useInviteSlotFocus'
import SlotCard from './screens/SlotCard'
import { InviteActionScreen } from './InviteActionScreen'
import { INVITE_HOW } from '../ParticipateFlow/ParticipateFlowInviteSlots'

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

describe('link-only invites', () => {
  // WHY: with only one invite method there is nothing to choose, so the Invite button must go
  // straight to the link screen instead of opening a one-item picker.
  it('opens the link action directly instead of the method picker', () => {
    const { result } = renderHook(() => useInviteHopFocus())
    act(() => result.current.openPicker(2, document.createElement('button')))
    expect(result.current.pickerHop).toBeNull()
    expect(result.current.view).toBe('action')
    expect(result.current.focusHop).toBe(2)
    expect(result.current.focusMethod).toBe('link')
  })

  // WHY: defence in depth — if the picker is ever opened, it must not offer an on-chain invite.
  it('offers only "Share link" in the method picker', () => {
    const anchor = document.body.appendChild(document.createElement('button'))
    render(
      <InviteMethodPicker open anchorEl={anchor} slotId={1} onSelect={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByRole('menuitem', { name: /Share link/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Whitelist new address/ })).toBeNull()
  })

  // WHY: the older two-button slot layout (shown when no picker handler is wired) must drop
  // "Invite onchain" and keep "Create link".
  it('drops "Invite onchain" from the two-button slot layout', () => {
    render(
      <SlotCard
        slot={{ id: 1, status: 'empty' }}
        onGenerateLink={vi.fn().mockResolvedValue(undefined)}
        onCopy={vi.fn()}
        onRevoke={vi.fn()}
        onInviteOnchain={vi.fn().mockResolvedValue(undefined)}
        isWrongNetwork={false}
      />,
    )
    expect(screen.getByRole('button', { name: 'Create link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite onchain' })).toBeNull()
  })

  // WHY: the action screen's method chooser (shown when no method is set yet) must not offer an
  // on-chain invite either.
  it('offers only "Share link" in the action screen method chooser', () => {
    render(
      <InviteActionScreen
        hop={2}
        method={null}
        onSelectMethod={vi.fn()}
        onBack={vi.fn()}
        onGenerateLink={vi.fn().mockResolvedValue(undefined)}
        onInviteOnchain={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.getByRole('button', { name: 'Share link' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Whitelist new address' })).toBeNull()
  })

  // WHY: the post-commit invite step's subtitle tells the user how to invite; it must not mention
  // an on-chain invite the profile does not offer.
  it('describes inviting as link-only in the invite step subtitle', () => {
    expect(INVITE_HOW).toBe('Share a link (no gas)')
  })
})
