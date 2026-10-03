// ABOUTME: Tests for deferred invite hiding — just-created invites stay off the list until confirmed.
// ABOUTME: Reveal is keyed by the created invite id, so it works even when the live row lands at another slot id.

import { describe, it, expect } from 'vitest'
import { createDeferredInviteHides } from './deferredInviteHides'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const LINK = 'https://fund.armada.blue/invite?n=1'

describe('createDeferredInviteHides', () => {
  it('hides an on-chain invite by address and reveals it by created id, whatever row id it lands at', () => {
    const hides = createDeferredInviteHides()
    // Created through empty slot 3; the live row is re-sorted into slot 1.
    hides.hide(3, { address: ADDRESS })
    const liveRow = { id: 1, status: 'onchain-pending' as const, invitedAddress: ADDRESS }
    expect(hides.isHidden(liveRow)).toBe(true)

    hides.reveal(3)
    expect(hides.isHidden(liveRow)).toBe(false)
  })

  it('matches addresses case-insensitively', () => {
    const hides = createDeferredInviteHides()
    hides.hide(2, { address: ADDRESS.toUpperCase().replace('0X', '0x') })
    expect(hides.isHidden({ id: 5, status: 'onchain-pending', invitedAddress: ADDRESS })).toBe(true)
  })

  it('hides a created link by URL until revealed or unhidden', () => {
    const hides = createDeferredInviteHides()
    hides.hide(4, { link: LINK })
    const row = { id: 4, status: 'link-active' as const, link: LINK }
    expect(hides.isHidden(row)).toBe(true)
    hides.unhideLink(LINK)
    expect(hides.isHidden(row)).toBe(false)
  })

  it('reveals only the invite it was asked to', () => {
    const hides = createDeferredInviteHides()
    const other = '0x2222222222222222222222222222222222222222'
    hides.hide(2, { address: ADDRESS })
    hides.hide(3, { address: other })
    hides.reveal(2)
    expect(hides.isHidden({ id: 1, status: 'onchain-pending', invitedAddress: ADDRESS })).toBe(false)
    expect(hides.isHidden({ id: 2, status: 'onchain-pending', invitedAddress: other })).toBe(true)
  })

  it('clears everything', () => {
    const hides = createDeferredInviteHides()
    hides.hide(2, { address: ADDRESS })
    hides.hide(3, { link: LINK })
    hides.clear()
    expect(hides.isHidden({ id: 1, status: 'onchain-pending', invitedAddress: ADDRESS })).toBe(false)
    expect(hides.isHidden({ id: 2, status: 'link-active', link: LINK })).toBe(false)
  })
})

describe('createDeferredInviteHides keyFor', () => {
  it('returns what identifies the invite created as an id, until revealed', () => {
    const hides = createDeferredInviteHides()
    hides.hide(4, { link: LINK })
    expect(hides.keyFor(4)).toEqual({ link: LINK, address: undefined })
    hides.reveal(4)
    expect(hides.keyFor(4)).toBeUndefined()
  })
})
