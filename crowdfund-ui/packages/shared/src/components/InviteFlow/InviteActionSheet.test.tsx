// ABOUTME: Tests for the mobile invite bottom sheet's dismissal (backdrop tap / Escape).
// ABOUTME: While an invite is being sent the sheet must not dismiss — the screen's Cancel is disabled then too.
// @vitest-environment jsdom

import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { InviteActionSheet } from './InviteActionSheet'
import { ParticipateFlowModal } from '../ParticipateFlow/ParticipateFlowModal'

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the page scroll lock calls it on release.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  // Mobile layout — the sheet only renders (and listens for Escape) on mobile.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

function renderSheet(dismissible?: boolean) {
  const onClose = vi.fn()
  render(
    <InviteActionSheet open onClose={onClose} ariaLabel="Invite to Hop-1" dismissible={dismissible}>
      <div>invite form</div>
    </InviteActionSheet>,
  )
  const scrim = document.body.querySelector<HTMLElement>('[role="presentation"]')!
  return { onClose, scrim }
}

describe('InviteActionSheet dismissal', () => {
  it('closes on a backdrop tap or Escape by default', () => {
    const { onClose, scrim } = renderSheet()
    fireEvent.click(scrim)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores a backdrop tap and Escape while not dismissible (invite in flight)', () => {
    const { onClose, scrim } = renderSheet(false)
    fireEvent.click(scrim)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('InviteActionSheet inside the participate modal', () => {
  it('Escape closes only the sheet, not the modal underneath', () => {
    const onSheetClose = vi.fn()
    const onModalClose = vi.fn()
    render(
      <ParticipateFlowModal open onClose={onModalClose} ariaLabel="Participate">
        <InviteActionSheet open onClose={onSheetClose} ariaLabel="Invite to Hop-1">
          <div>invite form</div>
        </InviteActionSheet>
      </ParticipateFlowModal>,
    )

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    expect(onSheetClose).toHaveBeenCalledOnce()
    expect(onModalClose).not.toHaveBeenCalled()
  })
})
