// ABOUTME: Unit tests for buildSlotRows — invite-slot row allocation.
// ABOUTME: Covers cross-device redemptions, on-chain priority, and redeemed persistence.
import { describe, it, expect } from 'vitest'
import { buildSlotRows } from './slotRows'
import type { StoredInviteLink } from './inviteLinks'

function link(nonce: number, status: StoredInviteLink['status'], createdAt = nonce): StoredInviteLink {
  return {
    inviter: '0x' + '11'.repeat(20),
    fromHop: 0,
    nonce,
    deadline: 1_700_000_000,
    signature: '0x' + 'ab'.repeat(65),
    createdAt,
    status,
  }
}

const A = '0x' + 'aa'.repeat(20)
const B = '0x' + 'bb'.repeat(20)

describe('buildSlotRows', () => {
  it('renders a cross-device redemption (no matching local link) as a redeemed row', () => {
    const { slots } = buildSlotRows({
      totalSlots: 2,
      startId: 1,
      activeLinks: [],
      linkRedemptions: new Map([[7, A]]),
      directInvitedAddresses: [],
    })
    expect(slots[0]).toMatchObject({ id: 1, status: 'redeemed', redeemedBy: A })
    expect(slots[1]).toMatchObject({ id: 2, status: 'empty' })
  })

  it('prioritizes on-chain rows over local pending links when slots are scarce', () => {
    // totalSlots 2: 1 redemption + 1 direct fill both slots; the pending local
    // link is dropped (on-chain consumption is the budget truth).
    const { slots } = buildSlotRows({
      totalSlots: 2,
      startId: 1,
      activeLinks: [link(5, 'pending')],
      linkRedemptions: new Map([[3, A]]),
      directInvitedAddresses: [B],
    })
    expect(slots.map((s) => s.status)).toEqual(['redeemed', 'onchain-pending'])
    expect(slots.find((s) => s.status === 'link-active')).toBeUndefined()
  })

  it('renders a pending local link as link-active and maps it for revoke', () => {
    const { slots, linkBySlotId } = buildSlotRows({
      totalSlots: 3,
      startId: 1,
      activeLinks: [link(5, 'pending')],
      linkRedemptions: new Map(),
      directInvitedAddresses: [],
    })
    const active = slots.find((s) => s.status === 'link-active')
    expect(active).toBeDefined()
    expect(linkBySlotId.get(active!.id)?.nonce).toBe(5)
  })

  it('keeps a redeemed link visible even when events lag (locally persisted)', () => {
    const { slots } = buildSlotRows({
      totalSlots: 1,
      startId: 1,
      activeLinks: [link(5, 'redeemed')],
      linkRedemptions: new Map(), // event stream hasn't caught up yet
      directInvitedAddresses: [],
    })
    expect(slots[0]).toMatchObject({ status: 'redeemed' })
  })

  it('does not double-count a redemption that also has a local redeemed link', () => {
    const { slots } = buildSlotRows({
      totalSlots: 3,
      startId: 1,
      activeLinks: [link(7, 'redeemed')],
      linkRedemptions: new Map([[7, A]]),
      directInvitedAddresses: [],
    })
    const redeemed = slots.filter((s) => s.status === 'redeemed')
    expect(redeemed).toHaveLength(1)
    expect(redeemed[0]).toMatchObject({ redeemedBy: A })
  })

  it('flags a self-invite (invitee === connected address)', () => {
    const { slots } = buildSlotRows({
      totalSlots: 2,
      startId: 1,
      activeLinks: [],
      linkRedemptions: new Map(),
      directInvitedAddresses: [A, B],
      selfAddress: A.toUpperCase(), // case-insensitive
    })
    const selfRow = slots.find((s) => s.invitedAddress === A)
    const otherRow = slots.find((s) => s.invitedAddress === B)
    expect(selfRow?.isSelf).toBe(true)
    expect(otherRow?.isSelf).toBe(false)
  })

  it('flags a self-redeemed link', () => {
    const { slots } = buildSlotRows({
      totalSlots: 1,
      startId: 1,
      activeLinks: [],
      linkRedemptions: new Map([[3, A]]),
      directInvitedAddresses: [],
      selfAddress: A,
    })
    expect(slots[0]).toMatchObject({ status: 'redeemed', isSelf: true })
  })

  it('pads with empty rows up to totalSlots', () => {
    const { slots } = buildSlotRows({
      totalSlots: 4,
      startId: 10,
      activeLinks: [link(1, 'pending')],
      linkRedemptions: new Map(),
      directInvitedAddresses: [],
    })
    expect(slots).toHaveLength(4)
    expect(slots.map((s) => s.id)).toEqual([10, 11, 12, 13])
    expect(slots.filter((s) => s.status === 'empty')).toHaveLength(3)
  })
})
