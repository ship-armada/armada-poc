// ABOUTME: Tests for which /invite steps get the taller, scrollable inline box instead of the fixed 480×500 one.
// ABOUTME: A step with the Max out banner hoisted above its card must not be clipped to 500px.
import { describe, it, expect } from 'vitest'
import { inviteStepNeedsRoom } from './inviteFlowLayout'

describe('inviteStepNeedsRoom', () => {
  it('expands the invite-slots step, which can be taller than the card', () => {
    expect(inviteStepNeedsRoom('invites', false)).toBe(true)
  })

  it('expands the commit and confirmation steps when the Max out banner sits above the card', () => {
    expect(inviteStepNeedsRoom('commit', true)).toBe(true)
    expect(inviteStepNeedsRoom('confirmation', true)).toBe(true)
  })

  it('keeps the fixed footprint for those steps without a Max out banner', () => {
    expect(inviteStepNeedsRoom('commit', false)).toBe(false)
    expect(inviteStepNeedsRoom('confirmation', false)).toBe(false)
  })

  it('keeps the fixed footprint for every other step', () => {
    for (const step of ['wallet', 'beforeYouStart', 'review', 'approve'] as const) {
      expect(inviteStepNeedsRoom(step, true)).toBe(false)
    }
  })
})
