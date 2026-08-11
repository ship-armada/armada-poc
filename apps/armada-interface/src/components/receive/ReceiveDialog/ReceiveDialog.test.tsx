// ABOUTME: Tests for ReceiveDialog — closed by default, displays full 0zk address when openModal=='receive' + unlocked, copy click writes to clipboard, locked state auto-closes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { openModalAtom } from '@/state/ui'

const hoisted = vi.hoisted(() => ({
  mockState: null as {
    id: string
    status: 'locked' | 'unlocked'
    shieldedAddress?: string
  } | null,
}))

vi.mock('@/hooks/useShieldedWallet', () => ({
  useShieldedWallet: () => ({ state: hoisted.mockState }),
}))

import { ReceiveDialog } from './ReceiveDialog'

const FULL_ADDRESS =
  '0zk1qexampleexampleexampleexampleexampleexampleexampleexampleexample1234567890'

function renderDialog(opts?: { openModal?: 'receive' | null }) {
  const store = createStore()
  if (opts?.openModal) store.set(openModalAtom, opts.openModal)
  render(
    <Provider store={store}>
      <ReceiveDialog />
    </Provider>,
  )
  return store
}

beforeEach(() => {
  hoisted.mockState = {
    id: 'rg-1',
    status: 'unlocked',
    shieldedAddress: FULL_ADDRESS,
  }
})

describe('<ReceiveDialog>', () => {
  it('renders nothing when openModal !== receive', () => {
    renderDialog({ openModal: null })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the title, helper copy, and full address when open + unlocked', () => {
    renderDialog({ openModal: 'receive' })
    expect(screen.getByRole('dialog', { name: 'Receive USDC privately' })).toBeInTheDocument()
    expect(
      screen.getByText('Share this address to receive USDC into your private balance.'),
    ).toBeInTheDocument()
    expect(screen.getByText(FULL_ADDRESS)).toBeInTheDocument()
  })

  it('writes the full address to the clipboard when Copy is clicked', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    renderDialog({ openModal: 'receive' })
    fireEvent.click(screen.getByRole('button', { name: /Copy address/i }))
    expect(writeText).toHaveBeenCalledWith(FULL_ADDRESS)
  })

  it('auto-closes when the wallet is not unlocked (no address to surface)', () => {
    hoisted.mockState = { id: 'rg-1', status: 'locked' }
    const store = renderDialog({ openModal: 'receive' })
    // WHY: defensive — if auto-lock fires while the dialog is open, the user shouldn't see a
    // stale address card. The effect drops the modal kind so the modal unmounts on the next
    // render pass.
    expect(store.get(openModalAtom)).toBeNull()
  })
})
