// ABOUTME: Tests for InviteActionScreen's link confirmation — revoking a just-created link.
// ABOUTME: Revoke must fire exactly once; discard (which the live wiring maps to a revoke) must not follow it.
// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { InviteActionScreen } from './InviteActionScreen'

const CREATED_ID = 7

function renderLinkScreen() {
  const handlers = {
    onBack: vi.fn(),
    onGenerateLink: vi.fn().mockResolvedValue({
      id: CREATED_ID,
      link: 'https://fund.armada.blue/invite?n=1',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    }),
    onInviteOnchain: vi.fn().mockResolvedValue(undefined),
    onRevoke: vi.fn().mockResolvedValue(undefined),
    onConfirmCreated: vi.fn(),
    onDiscardCreated: vi.fn(),
  }
  render(<InviteActionScreen hop={1} method="link" {...handlers} />)
  return handlers
}

describe('InviteActionScreen link confirmation', () => {
  it('revokes a just-created link exactly once and does not also discard it', async () => {
    const handlers = renderLinkScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText('Link ready to share')

    fireEvent.click(screen.getByRole('button', { name: 'More link actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke link' }))

    await waitFor(() => expect(handlers.onBack).toHaveBeenCalledOnce())
    expect(handlers.onRevoke).toHaveBeenCalledOnce()
    // The URL lets the live wiring find the link wherever its row now sits.
    expect(handlers.onRevoke).toHaveBeenCalledWith(CREATED_ID, 'https://fund.armada.blue/invite?n=1')
    expect(handlers.onDiscardCreated).not.toHaveBeenCalled()
    expect(handlers.onConfirmCreated).not.toHaveBeenCalled()
  })

  it('reveals the link in the list on Done without revoking', async () => {
    const handlers = renderLinkScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText('Link ready to share')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(handlers.onConfirmCreated).toHaveBeenCalledWith(CREATED_ID)
    expect(handlers.onRevoke).not.toHaveBeenCalled()
    expect(handlers.onDiscardCreated).not.toHaveBeenCalled()
    expect(handlers.onBack).toHaveBeenCalledOnce()
  })
})

describe('InviteActionScreen in-flight state', () => {
  const baseProps = {
    hop: 1 as const,
    onBack: vi.fn(),
    onGenerateLink: vi.fn().mockResolvedValue(undefined),
    onInviteOnchain: vi.fn().mockResolvedValue(undefined),
  }

  it('shows the on-chain invite as busy and disables Cancel while the tx is in flight', () => {
    render(<InviteActionScreen {...baseProps} method="onchain" loading />)
    const invite = screen.getByRole('button', { name: /Inviting/ })
    expect(invite.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows link creation as busy and disables Cancel while the signature is pending', () => {
    render(<InviteActionScreen {...baseProps} method="link" loading />)
    const create = screen.getByRole('button', { name: /Creating/ })
    expect(create.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps Cancel enabled when nothing is in flight', () => {
    render(<InviteActionScreen {...baseProps} method="onchain" />)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
