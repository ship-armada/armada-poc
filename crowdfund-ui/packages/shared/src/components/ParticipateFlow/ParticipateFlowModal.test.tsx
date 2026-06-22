// ABOUTME: Regression tests for ParticipateFlowModal close behavior.
// ABOUTME: While a tx is in flight, closing must require confirmation.
// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ParticipateFlowModal } from './ParticipateFlowModal.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function renderModal(props: Partial<Parameters<typeof ParticipateFlowModal>[0]>) {
  const onClose = vi.fn()
  render(
    <ParticipateFlowModal open onClose={onClose} ariaLabel="Participate" {...props}>
      <div>flow body</div>
    </ParticipateFlowModal>,
  )
  return { onClose }
}

describe('ParticipateFlowModal close', () => {
  it('closes immediately when no transaction is in flight', () => {
    const { onClose } = renderModal({ confirmBeforeClose: false })
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close on cancelled confirm while a tx is in flight', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onClose } = renderModal({ confirmBeforeClose: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(window.confirm).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on accepted confirm while a tx is in flight', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onClose } = renderModal({ confirmBeforeClose: true })
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
