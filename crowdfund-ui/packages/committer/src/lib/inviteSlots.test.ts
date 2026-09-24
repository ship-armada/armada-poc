// ABOUTME: Unit tests for the invite-slot availability gate.
// ABOUTME: Guards against the bigint-vs-number comparison bug (remaining === 0 always false).
import { describe, it, expect } from 'vitest'
import { hasFreeInviteSlot, hasNoInviteSlots } from './inviteSlots'

describe('hasNoInviteSlots', () => {
  it('returns true for 0n (no slots left)', () => {
    expect(hasNoInviteSlots(0n)).toBe(true)
  })

  it('returns false when slots remain', () => {
    expect(hasNoInviteSlots(1n)).toBe(false)
    expect(hasNoInviteSlots(5n)).toBe(false)
  })
})

describe('hasFreeInviteSlot', () => {
  const section = (statuses: Array<'empty' | 'redeemed' | 'link-active'>) => ({
    config: { slots: statuses.map((status, i) => ({ id: i + 1, status })) },
  })

  it('returns true when any section has an empty slot', () => {
    expect(hasFreeInviteSlot([section(['redeemed']), section(['link-active', 'empty'])])).toBe(true)
  })

  it('returns false when every slot is used', () => {
    expect(hasFreeInviteSlot([section(['redeemed', 'link-active'])])).toBe(false)
  })

  it('returns false for sections without slots (Hop-2) or no sections', () => {
    expect(hasFreeInviteSlot([section([])])).toBe(false)
    expect(hasFreeInviteSlot([])).toBe(false)
    expect(hasFreeInviteSlot(undefined)).toBe(false)
  })
})
