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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke' }))

    await waitFor(() => expect(handlers.onBack).toHaveBeenCalledOnce())
    expect(handlers.onRevoke).toHaveBeenCalledOnce()
    // The URL lets the live wiring find the link wherever its row now sits.
    expect(handlers.onRevoke).toHaveBeenCalledWith(CREATED_ID, 'https://fund.armada.blue/invite?n=1')
    expect(handlers.onDiscardCreated).not.toHaveBeenCalled()
    expect(handlers.onConfirmCreated).not.toHaveBeenCalled()
  })

  it('explains how to use the link once it is ready', async () => {
    renderLinkScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText('Link ready to share')
    expect(
      screen.getByText(
        'Share it privately. The recipient opens the link, connects their wallet, and commits USDC to join the fleet.',
      ),
    ).toBeTruthy()
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

describe('InviteActionScreen dismissed without Done', () => {
  // A sheet backdrop tap / Escape (or a layout remount) unmounts the screen
  // without Done. The created invite must still be revealed — never left
  // hidden, and never discarded (which the live wiring maps to a revoke).
  it('reveals a created link when the screen unmounts', async () => {
    const onConfirmCreated = vi.fn()
    const onDiscardCreated = vi.fn()
    const { unmount } = render(
      <InviteActionScreen
        hop={1}
        method="link"
        onBack={vi.fn()}
        onGenerateLink={vi.fn().mockResolvedValue({
          id: CREATED_ID,
          link: 'https://fund.armada.blue/invite?n=1',
          expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        })}
        onInviteOnchain={vi.fn()}
        onConfirmCreated={onConfirmCreated}
        onDiscardCreated={onDiscardCreated}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText('Link ready to share')

    unmount()

    expect(onConfirmCreated).toHaveBeenCalledWith(CREATED_ID)
    expect(onDiscardCreated).not.toHaveBeenCalled()
  })

  it('reveals an invite whose creation finishes after the screen is gone', async () => {
    let resolveCreate!: (v: unknown) => void
    const onConfirmCreated = vi.fn()
    const onDiscardCreated = vi.fn()
    const { unmount } = render(
      <InviteActionScreen
        hop={1}
        method="link"
        onBack={vi.fn()}
        onGenerateLink={vi.fn(() => new Promise((res) => (resolveCreate = res))) as never}
        onInviteOnchain={vi.fn()}
        onConfirmCreated={onConfirmCreated}
        onDiscardCreated={onDiscardCreated}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    unmount()

    resolveCreate({
      id: CREATED_ID,
      link: 'https://fund.armada.blue/invite?n=1',
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    })
    await waitFor(() => expect(onConfirmCreated).toHaveBeenCalledWith(CREATED_ID))
    expect(onDiscardCreated).not.toHaveBeenCalled()
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

describe('InviteActionScreen explainer and close control', () => {
  it('explains that an on-chain invite is a gas-paying transaction', () => {
    render(<InviteActionScreen hop={1} method="onchain" onBack={vi.fn()} onGenerateLink={vi.fn()} onInviteOnchain={vi.fn()} />)
    expect(
      screen.getByText(
        'This sends an onchain transaction. The invitee can then open the crowdfund website and commit. Requires gas.',
      ),
    ).toBeTruthy()
  })

  it('explains that creating a link only needs a signature, no gas', () => {
    render(<InviteActionScreen hop={1} method="link" onBack={vi.fn()} onGenerateLink={vi.fn()} onInviteOnchain={vi.fn()} />)
    expect(
      screen.getByText(
        'Your wallet will sign a message to generate the link — no gas required. You can revoke the link anytime before someone uses it.',
      ),
    ).toBeTruthy()
  })

  it('tells the inviter what the invitee does next once an on-chain invite is sent', async () => {
    const invitee = '0x' + 'b'.repeat(40)
    render(
      <InviteActionScreen
        hop={1}
        method="onchain"
        onBack={vi.fn()}
        onGenerateLink={vi.fn()}
        onInviteOnchain={vi.fn().mockResolvedValue({ id: CREATED_ID, address: invitee })}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: invitee } })
    fireEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

    expect(
      await screen.findByText(
        'They can open the crowdfund website, connect this wallet, and commit USDC anytime before the deadline.',
      ),
    ).toBeTruthy()
  })

  it('uses the self-invite wording when you invite your own wallet', async () => {
    const me = '0x' + 'b'.repeat(40)
    render(
      <InviteActionScreen
        hop={1}
        method="onchain"
        selfWalletAddress={me}
        onBack={vi.fn()}
        onGenerateLink={vi.fn()}
        onInviteOnchain={vi.fn().mockResolvedValue({ id: CREATED_ID, address: me })}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: me } })
    fireEvent.click(await screen.findByRole('button', { name: 'Self invite' }))

    expect(
      await screen.findByText(
        'You invited yourself. Open the crowdfund website with this wallet and commit USDC anytime before the deadline.',
      ),
    ).toBeTruthy()
  })

  it('shows the full invited address and that they have not committed yet', async () => {
    const invitee = '0x' + 'b'.repeat(40)
    render(
      <InviteActionScreen
        hop={1}
        method="onchain"
        onBack={vi.fn()}
        onGenerateLink={vi.fn()}
        onInviteOnchain={vi.fn().mockResolvedValue({ id: CREATED_ID, address: invitee })}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: invitee } })
    fireEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

    expect(await screen.findByText(invitee)).toBeTruthy()
    expect(screen.getByText('Waiting to commit')).toBeTruthy()
  })

  it('closes the form from the top-right X like Cancel', () => {
    const onBack = vi.fn()
    const onDiscardCreated = vi.fn()
    render(
      <InviteActionScreen
        hop={1}
        method="onchain"
        onBack={onBack}
        onGenerateLink={vi.fn()}
        onInviteOnchain={vi.fn()}
        onDiscardCreated={onDiscardCreated}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close invite' }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(onDiscardCreated).not.toHaveBeenCalled()
  })

  it('disables the X while the invite is in flight', () => {
    render(<InviteActionScreen hop={1} method="onchain" loading onBack={vi.fn()} onGenerateLink={vi.fn()} onInviteOnchain={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Close invite' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('treats the X on a just-created link as Done — keeps it, never revokes', async () => {
    const handlers = renderLinkScreen()
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await screen.findByText('Link ready to share')

    fireEvent.click(screen.getByRole('button', { name: 'Close invite' }))

    expect(handlers.onConfirmCreated).toHaveBeenCalledWith(CREATED_ID)
    expect(handlers.onDiscardCreated).not.toHaveBeenCalled()
    expect(handlers.onRevoke).not.toHaveBeenCalled()
    expect(handlers.onBack).toHaveBeenCalledOnce()
  })
})

