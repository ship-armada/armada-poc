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
  inviterOnChainNonces,
  effectiveTimestamp,
  classifyStoredLinks,
  type InviteLinkData,
  type StoredInviteLink,
} from './inviteLinks'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

const TEST_INVITER = '0x1111111111111111111111111111111111111111'

function invitedEvent(inviter: string, nonce: number): CrowdfundEvent {
  return {
    type: 'Invited',
    blockNumber: nonce + 1,
    transactionHash: '0x' + (nonce + 1).toString(16).padStart(64, '0'),
    logIndex: 0,
    args: { inviter, invitee: '0x' + '22'.repeat(20), hop: 1, nonce: BigInt(nonce) },
  }
}

function revokedEvent(inviter: string, nonce: number): CrowdfundEvent {
  return {
    type: 'InviteNonceRevoked',
    blockNumber: nonce + 500,
    transactionHash: '0x' + (nonce + 500).toString(16).padStart(64, '0'),
    logIndex: 0,
    args: { inviter, nonce: BigInt(nonce) },
  }
}

function storedLink(
  nonce: number,
  status: StoredInviteLink['status'],
  deadline: number,
): StoredInviteLink {
  return {
    inviter: TEST_INVITER.toLowerCase(),
    fromHop: 0,
    nonce,
    deadline,
    signature: '0x' + 'ab'.repeat(65),
    createdAt: 1000,
    status,
  }
}

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
  // Vitalik's address — known-valid EIP-55 checksum; `tryGetChecksumAddress`
  // requires checksum-valid input. Use this stable fixture across all decode
  // tests so casing tricks don't quietly slip past the validator.
  const VALID_INVITER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  // Real ECDSA signatures are 65 bytes → 130 hex chars + '0x'.
  const VALID_SIG =
    '0x' + 'ab'.repeat(64) + '1b'

  const linkData: InviteLinkData = {
    inviter: VALID_INVITER,
    fromHop: 0,
    nonce: 42,
    deadline: 1700000000,
    signature: VALID_SIG,
  }

  function paramsWith(overrides: Partial<Record<string, string>> = {}): URLSearchParams {
    return new URLSearchParams({
      inviter: VALID_INVITER,
      fromHop: '0',
      nonce: '42',
      deadline: '1700000000',
      sig: VALID_SIG,
      ...overrides,
    })
  }

  it('encodes to a /invite URL with query params', () => {
    const url = encodeInviteUrl(linkData)
    expect(url).toContain('/invite?')
    expect(url).toContain('inviter=')
    expect(url).toContain('fromHop=0')
    expect(url).toContain('nonce=42')
    expect(url).toContain('deadline=1700000000')
    expect(url).toContain(`sig=${VALID_SIG}`)
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
    expect(decodeInviteUrl(paramsWith({ inviter: 'not-an-address' }))).toBeNull()
  })

  it('returns null for inviter with a bad EIP-55 checksum', () => {
    // Same hex, wrong casing — passes 0x+40-hex format but fails checksum.
    const badChecksum = VALID_INVITER.replace('d8dA', 'D8dA')
    expect(decodeInviteUrl(paramsWith({ inviter: badChecksum }))).toBeNull()
  })

  it('returns null for non-numeric hop/nonce/deadline', () => {
    expect(decodeInviteUrl(paramsWith({ fromHop: 'abc' }))).toBeNull()
  })

  it('returns null for partially-numeric nonce (parseInt-style truncation attempt)', () => {
    // `parseInt('42abc', 10)` returns 42 — the strict parser must reject.
    expect(decodeInviteUrl(paramsWith({ nonce: '42abc' }))).toBeNull()
  })

  it('returns null for negative nonce', () => {
    expect(decodeInviteUrl(paramsWith({ nonce: '-1' }))).toBeNull()
  })

  it('returns null for scientific-notation deadline', () => {
    expect(decodeInviteUrl(paramsWith({ deadline: '1e10' }))).toBeNull()
  })

  it('returns null for fromHop above MAX_HOP_INDEX', () => {
    expect(decodeInviteUrl(paramsWith({ fromHop: '3' }))).toBeNull()
  })

  it('returns null for signature without 0x prefix', () => {
    expect(decodeInviteUrl(paramsWith({ sig: 'a'.repeat(130) }))).toBeNull()
  })

  it('returns null for too-short signature', () => {
    expect(decodeInviteUrl(paramsWith({ sig: '0xdeadbeef' }))).toBeNull()
  })

  it('returns null for signature with non-hex characters', () => {
    const badHex = '0x' + 'z'.repeat(130)
    expect(decodeInviteUrl(paramsWith({ sig: badHex }))).toBeNull()
  })

  it('accepts an all-lowercase inviter (ethers normalizes to checksum)', () => {
    const decoded = decodeInviteUrl(paramsWith({ inviter: VALID_INVITER.toLowerCase() }))
    expect(decoded).not.toBeNull()
    expect(decoded!.inviter).toBe(VALID_INVITER)
  })

  it('tolerates leading/trailing whitespace on inviter and signature', () => {
    const decoded = decodeInviteUrl(
      paramsWith({
        inviter: `  ${VALID_INVITER}  `,
        sig: `  ${VALID_SIG}  `,
      }),
    )
    expect(decoded).not.toBeNull()
    expect(decoded!.inviter).toBe(VALID_INVITER)
    expect(decoded!.signature).toBe(VALID_SIG)
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

describe('inviterOnChainNonces', () => {
  it('collects redeemed (Invited) and revoked nonces for the inviter', () => {
    const events: CrowdfundEvent[] = [
      invitedEvent(TEST_INVITER, 1),
      revokedEvent(TEST_INVITER, 2),
      invitedEvent('0x9999999999999999999999999999999999999999', 7), // other inviter
    ]
    expect(inviterOnChainNonces(events, TEST_INVITER).sort((a, b) => a - b)).toEqual([1, 2])
  })

  it('is case-insensitive on the inviter address', () => {
    const events = [invitedEvent(TEST_INVITER.toUpperCase(), 3)]
    expect(inviterOnChainNonces(events, TEST_INVITER.toLowerCase())).toEqual([3])
  })
})

describe('getNextNonce with on-chain history', () => {
  it('returns 1 for empty local + empty on-chain', async () => {
    expect(await getNextNonce('0xempty-' + Math.random().toString(16))).toBe(1)
  })

  it('seeds past consumed on-chain nonces on a fresh device (1-3 → 4)', async () => {
    // Fresh inviter key (no local links) but nonces 1..3 consumed on-chain.
    const fresh = '0x' + 'ab'.repeat(20)
    expect(await getNextNonce(fresh, [1, 2, 3])).toBe(4)
  })
})

describe('effectiveTimestamp', () => {
  it('passes through a real block timestamp', () => {
    expect(effectiveTimestamp(1_700_000_000)).toBe(1_700_000_000)
  })

  it('falls back to wall-clock when block timestamp is 0 (not 1970)', () => {
    const ts = effectiveTimestamp(0)
    const nowish = Math.floor(Date.now() / 1000)
    expect(Math.abs(ts - nowish)).toBeLessThan(5)
  })
})

describe('classifyStoredLinks', () => {
  it('marks a redeemed nonce as redeemed even past its deadline', () => {
    const out = classifyStoredLinks([storedLink(1, 'pending', 100)], new Set([1]), 999_999)
    expect(out[0].status).toBe('redeemed')
  })

  it('expires only still-pending links past the deadline', () => {
    const out = classifyStoredLinks([storedLink(2, 'pending', 100)], new Set(), 999_999)
    expect(out[0].status).toBe('expired')
  })

  it('leaves a revoked link revoked even if its nonce appears redeemed', () => {
    const out = classifyStoredLinks([storedLink(3, 'revoked', 100)], new Set([3]), 999_999)
    expect(out[0].status).toBe('revoked')
  })
})

describe('storeInviteLink inviter normalization', () => {
  it('stores a checksummed inviter under its lowercase key', async () => {
    const checksummed = '0xAbC0000000000000000000000000000000000abc'
    await storeInviteLink({
      inviter: checksummed,
      fromHop: 0,
      nonce: 42,
      deadline: 1_700_000_000,
      signature: '0x' + 'cd'.repeat(65),
      createdAt: 1000,
      status: 'pending',
    })
    const found = await getStoredInviteLinks(checksummed.toLowerCase())
    expect(found.some((l) => l.nonce === 42)).toBe(true)
  })
})
