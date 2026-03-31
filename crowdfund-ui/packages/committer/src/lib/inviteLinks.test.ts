// ABOUTME: Tests for EIP-712 invite link encoding, decoding, and IndexedDB CRUD.
// ABOUTME: Verifies URL round-trip, domain construction, and stored link lifecycle.

import { describe, it, expect } from 'vitest'
import {
  getEIP712Domain,
  INVITE_TYPES,
  encodeInviteUrl,
  decodeInviteUrl,
  storeInviteLink,
  getStoredInviteLinks,
  updateInviteLinkStatus,
  getNextNonce,
  type InviteLinkData,
  type StoredInviteLink,
} from './inviteLinks'

describe('getEIP712Domain', () => {
  it('returns correct domain structure', () => {
    const domain = getEIP712Domain(31337, '0x1234567890abcdef1234567890abcdef12345678')
    expect(domain).toEqual({
      name: 'ArmadaCrowdfund',
      version: '1',
      chainId: 31337,
      verifyingContract: '0x1234567890abcdef1234567890abcdef12345678',
    })
  })
})

describe('INVITE_TYPES', () => {
  it('has Invite type with correct fields', () => {
    expect(INVITE_TYPES.Invite).toEqual([
      { name: 'inviter', type: 'address' },
      { name: 'fromHop', type: 'uint8' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ])
  })
})

describe('encodeInviteUrl / decodeInviteUrl round-trip', () => {
  const linkData: InviteLinkData = {
    inviter: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
    fromHop: 0,
    nonce: 42,
    deadline: 1700000000,
    signature: '0xdeadbeef1234',
  }

  it('encodes to a /invite URL with query params', () => {
    const url = encodeInviteUrl(linkData)
    expect(url).toContain('/invite?')
    expect(url).toContain('inviter=')
    expect(url).toContain('fromHop=0')
    expect(url).toContain('nonce=42')
    expect(url).toContain('deadline=1700000000')
    expect(url).toContain('sig=0xdeadbeef1234')
  })

  it('round-trips through encode → decode', () => {
    const url = encodeInviteUrl(linkData)
    const queryString = url.split('?')[1]
    const params = new URLSearchParams(queryString)
    const decoded = decodeInviteUrl(params)

    expect(decoded).not.toBeNull()
    expect(decoded!.inviter).toBe(linkData.inviter)
    expect(decoded!.fromHop).toBe(linkData.fromHop)
    expect(decoded!.nonce).toBe(linkData.nonce)
    expect(decoded!.deadline).toBe(linkData.deadline)
    expect(decoded!.signature).toBe(linkData.signature)
  })

  it('returns null for missing parameters', () => {
    expect(decodeInviteUrl(new URLSearchParams())).toBeNull()
    expect(decodeInviteUrl(new URLSearchParams('inviter=0x1234'))).toBeNull()
  })

  it('returns null for invalid inviter address', () => {
    const params = new URLSearchParams({
      inviter: 'not-an-address',
      fromHop: '0',
      nonce: '1',
      deadline: '1700000000',
      sig: '0xabc',
    })
    expect(decodeInviteUrl(params)).toBeNull()
  })

  it('returns null for non-numeric hop/nonce/deadline', () => {
    const params = new URLSearchParams({
      inviter: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      fromHop: 'abc',
      nonce: '1',
      deadline: '1700000000',
      sig: '0xabc',
    })
    expect(decodeInviteUrl(params)).toBeNull()
  })

  it('returns null for signature without 0x prefix', () => {
    const params = new URLSearchParams({
      inviter: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01',
      fromHop: '0',
      nonce: '1',
      deadline: '1700000000',
      sig: 'deadbeef',
    })
    expect(decodeInviteUrl(params)).toBeNull()
  })
})

describe('IndexedDB CRUD', () => {
  // Use a unique inviter per test to avoid cross-contamination
  let testCounter = 0
  function uniqueInviter(): string {
    testCounter++
    const hex = testCounter.toString(16).padStart(40, '0')
    return `0x${hex}`
  }

  it('stores and retrieves an invite link', async () => {
    const inviter = uniqueInviter()
    const link: StoredInviteLink = {
      inviter,
      fromHop: 0,
      nonce: 1,
      deadline: 1700000000,
      signature: '0xabc',
      createdAt: Date.now(),
      status: 'pending',
    }
    await storeInviteLink(link)
    const retrieved = await getStoredInviteLinks(inviter)
    expect(retrieved).toHaveLength(1)
    expect(retrieved[0].nonce).toBe(1)
    expect(retrieved[0].status).toBe('pending')
  })

  it('updates link status', async () => {
    const inviter = uniqueInviter()
    const link: StoredInviteLink = {
      inviter,
      fromHop: 0,
      nonce: 1,
      deadline: 1700000000,
      signature: '0xabc',
      createdAt: Date.now(),
      status: 'pending',
    }
    await storeInviteLink(link)
    await updateInviteLinkStatus(inviter, 1, 'revoked')
    const retrieved = await getStoredInviteLinks(inviter)
    expect(retrieved[0].status).toBe('revoked')
  })

  it('getNextNonce returns 1 for empty db', async () => {
    const inviter = uniqueInviter()
    const nonce = await getNextNonce(inviter)
    expect(nonce).toBe(1)
  })

  it('getNextNonce returns max + 1', async () => {
    const inviter = uniqueInviter()
    await storeInviteLink({
      inviter,
      fromHop: 0,
      nonce: 5,
      deadline: 1700000000,
      signature: '0xabc',
      createdAt: Date.now(),
      status: 'pending',
    })
    await storeInviteLink({
      inviter,
      fromHop: 0,
      nonce: 3,
      deadline: 1700000000,
      signature: '0xdef',
      createdAt: Date.now(),
      status: 'pending',
    })
    const nonce = await getNextNonce(inviter)
    expect(nonce).toBe(6)
  })
})
