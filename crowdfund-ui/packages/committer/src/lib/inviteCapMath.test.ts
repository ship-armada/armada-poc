// ABOUTME: Unit tests for the /invite effective-cap math.
// ABOUTME: (invitesReceived + 1) * perSlotCap — the contract scales the cap on redemption.
import { describe, it, expect } from 'vitest'
import { effectiveInviteCapUsdc } from './inviteCapMath'

const CAP = 1_000n * 10n ** 6n // $1,000 per slot

describe('effectiveInviteCapUsdc', () => {
  it('is 1x for a first-time invitee (invitesReceived 0)', () => {
    expect(effectiveInviteCapUsdc(0, CAP)).toBe(CAP)
  })

  it('scales by (invitesReceived + 1) for a re-invited user', () => {
    expect(effectiveInviteCapUsdc(2, CAP)).toBe(3n * CAP)
  })

  it('treats negative/garbage invitesReceived as 0 (1x)', () => {
    expect(effectiveInviteCapUsdc(-5, CAP)).toBe(CAP)
  })
})
