// ABOUTME: Tests for sending on-chain invites and revoking links through live invite sections.
// ABOUTME: Invite success needs the section's confirmation; revokes resolve the link by URL, not slot id.

import { describe, it, expect, vi } from 'vitest'
import {
  inviteOnchainViaSections,
  revokeLinkViaSections,
  type InviteSectionLike,
} from './inviteSectionsToCard'

const ADDRESS = '0x1111111111111111111111111111111111111111'

function makeSection(
  overrides: Partial<InviteSectionLike['config']> = {},
  hop: 0 | 1 | 2 = 0,
): InviteSectionLike {
  return {
    hop,
    totalSlots: 3,
    config: {
      slots: [
        { id: 1, status: 'redeemed' },
        { id: 2, status: 'empty' },
        { id: 3, status: 'empty' },
      ],
      onGenerateLink: vi.fn().mockResolvedValue(undefined),
      onRevoke: vi.fn(),
      onInviteOnchain: vi.fn().mockResolvedValue(true),
      ...overrides,
    },
  }
}

describe('inviteOnchainViaSections', () => {
  it('sends through the first empty slot and returns the created invite once confirmed', async () => {
    const section = makeSection()
    const created = await inviteOnchainViaSections([section], 1, ADDRESS, 'friend.eth')
    expect(section.config.onInviteOnchain).toHaveBeenCalledWith(2, ADDRESS, 'friend.eth')
    expect(created).toEqual({ id: 2, address: ADDRESS, ensName: 'friend.eth' })
  })

  it('returns undefined when the section reports the invite was not sent', async () => {
    const section = makeSection({ onInviteOnchain: vi.fn().mockResolvedValue(false) })
    const created = await inviteOnchainViaSections([section], 1, ADDRESS)
    expect(section.config.onInviteOnchain).toHaveBeenCalledOnce()
    expect(created).toBeUndefined()
  })

  it('prompts a network switch instead of sending on the wrong network', async () => {
    const onSwitchNetwork = vi.fn()
    const section = makeSection({ isWrongNetwork: true, onSwitchNetwork })
    const created = await inviteOnchainViaSections([section], 1, ADDRESS)
    expect(onSwitchNetwork).toHaveBeenCalledOnce()
    expect(section.config.onInviteOnchain).not.toHaveBeenCalled()
    expect(created).toBeUndefined()
  })

  it('routes a Hop-2 invitee through the Hop-1 section', async () => {
    const hop0 = makeSection({}, 0)
    const hop1 = makeSection({}, 1)
    await inviteOnchainViaSections([hop0, hop1], 2, ADDRESS)
    expect(hop0.config.onInviteOnchain).not.toHaveBeenCalled()
    expect(hop1.config.onInviteOnchain).toHaveBeenCalledOnce()
  })

  it('returns undefined without sending when no slot is empty', async () => {
    const section = makeSection({ slots: [{ id: 1, status: 'redeemed' }] })
    const created = await inviteOnchainViaSections([section], 1, ADDRESS)
    expect(section.config.onInviteOnchain).not.toHaveBeenCalled()
    expect(created).toBeUndefined()
  })
})

describe('inviteOnchainViaSections onBeforeSend', () => {
  it('reports the slot id before the invite is sent, so callers can hide the row first', async () => {
    const calls: string[] = []
    const section = makeSection({
      onInviteOnchain: vi.fn(async () => {
        calls.push('send')
        return true
      }),
    })
    await inviteOnchainViaSections([section], 1, ADDRESS, undefined, (slotId) => {
      calls.push(`before:${slotId}`)
    })
    expect(calls).toEqual(['before:2', 'send'])
  })

  it('does not report a slot when nothing will be sent', async () => {
    const onBeforeSend = vi.fn()
    const wrongNetwork = makeSection({ isWrongNetwork: true })
    await inviteOnchainViaSections([wrongNetwork], 1, ADDRESS, undefined, onBeforeSend)
    const full = makeSection({ slots: [{ id: 1, status: 'redeemed' }] })
    await inviteOnchainViaSections([full], 1, ADDRESS, undefined, onBeforeSend)
    expect(onBeforeSend).not.toHaveBeenCalled()
  })
})

describe('revokeLinkViaSections', () => {
  const LINK_A = 'https://fund.armada.blue/invite?nonce=11'
  const LINK_B = 'https://fund.armada.blue/invite?nonce=22'

  it('revokes the slot currently holding the link, not a stale slot id', () => {
    // LINK_B was created through slot 2. A direct invite has since landed and
    // sorts ahead of links, so LINK_A now sits in slot 2 and LINK_B in slot 3.
    const section = makeSection({
      slots: [
        { id: 1, status: 'onchain-pending', invitedAddress: ADDRESS },
        { id: 2, status: 'link-active', link: LINK_A },
        { id: 3, status: 'link-active', link: LINK_B },
      ],
    })
    expect(revokeLinkViaSections([section], LINK_B)).toBe(true)
    expect(section.config.onRevoke).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('finds the link in whichever section holds it', () => {
    const hop0 = makeSection({ slots: [{ id: 1, status: 'link-active', link: LINK_A }] }, 0)
    const hop1 = makeSection({ slots: [{ id: 4, status: 'link-active', link: LINK_B }] }, 1)
    revokeLinkViaSections([hop0, hop1], LINK_B)
    expect(hop0.config.onRevoke).not.toHaveBeenCalled()
    expect(hop1.config.onRevoke).toHaveBeenCalledExactlyOnceWith(4)
  })

  it('revokes nothing when the link is not in any section', () => {
    const section = makeSection({ slots: [{ id: 1, status: 'link-active', link: LINK_A }] })
    expect(revokeLinkViaSections([section], LINK_B)).toBe(false)
    expect(section.config.onRevoke).not.toHaveBeenCalled()
  })
})
