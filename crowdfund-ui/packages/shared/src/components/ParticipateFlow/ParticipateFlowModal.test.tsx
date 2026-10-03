// ABOUTME: Regression tests for ParticipateFlowModal close behavior.
// ABOUTME: While a tx is in flight, closing must require confirmation.
// @vitest-environment jsdom

import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ParticipateFlowModal } from './ParticipateFlowModal.js'

beforeEach(() => {
  // jsdom doesn't implement scrollTo; the page scroll lock calls it on release.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  // Unmount before restoring mocks so the lock's release still hits the stub.
  cleanup()
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

  it('hides the close control when showClose is false', () => {
    renderModal({ showClose: false, footer: <button type="button">Do it later</button> })
    expect(screen.queryByRole('button', { name: 'Close participate flow' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Do it later' })).toBeTruthy()
  })

  it('asks with a caller-supplied message (e.g. the claim flow)', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderModal({ confirmBeforeClose: true, closeConfirmMessage: 'Claim still running. Close?' })
    fireEvent.click(screen.getByRole('button', { name: 'Close participate flow' }))
    expect(window.confirm).toHaveBeenCalledWith('Claim still running. Close?')
  })

  it('labels its X for the hosted flow (e.g. Claim)', () => {
    const { onClose } = renderModal({ closeAriaLabel: 'Close claim flow' })
    fireEvent.click(screen.getByRole('button', { name: 'Close claim flow' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
