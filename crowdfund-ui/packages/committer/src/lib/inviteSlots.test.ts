// ABOUTME: Unit tests for the invite-slot availability gate.
// ABOUTME: Guards against the bigint-vs-number comparison bug (remaining === 0 always false).
import { describe, it, expect } from 'vitest'
import { hasNoInviteSlots } from './inviteSlots'

describe('hasNoInviteSlots', () => {
  it('returns true for 0n (no slots left)', () => {
    expect(hasNoInviteSlots(0n)).toBe(true)
  })

  it('returns false when slots remain', () => {
    expect(hasNoInviteSlots(1n)).toBe(false)
    expect(hasNoInviteSlots(5n)).toBe(false)
  })
})
