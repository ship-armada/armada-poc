// ABOUTME: Tests for the mobile invite bottom sheet's dismissal (backdrop tap / Escape).
// ABOUTME: While an invite is being sent the sheet must not dismiss — the screen's Cancel is disabled then too.
// @vitest-environment jsdom

import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { InviteActionSheet } from './InviteActionSheet'

beforeAll(() => {
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
