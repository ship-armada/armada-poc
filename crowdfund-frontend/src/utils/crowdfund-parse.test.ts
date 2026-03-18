// ABOUTME: Tests for crowdfund contract struct parsing functions.
// ABOUTME: Validates field extraction, type conversions, and edge cases.
import { describe, it, expect } from 'vitest'
import { parseParticipant, parseHopStats } from './crowdfund-parse'

describe('parseParticipant', () => {
  it('parses a fully populated participant struct', () => {
    // Struct order: isWhitelisted, invitesReceived, committed, allocation, refund, claimed, invitedBy, invitesSent
    const result = [true, 2n, 500_000_000n, 500_000_000n, 0n, false, '0xabc123', 2n]
    const p = parseParticipant(result)

    expect(p.isWhitelisted).toBe(true)
    expect(p.invitesReceived).toBe(2)
    expect(p.committed).toBe(500_000_000n)
    expect(p.allocation).toBe(500_000_000n)
    expect(p.refund).toBe(0n)
    expect(p.claimed).toBe(false)
    expect(p.invitedBy).toBe('0xabc123')
    expect(p.invitesSent).toBe(2)
  })

  it('parses zero/default values', () => {
    const result = [false, 0n, 0n, 0n, 0n, false, '0x0000000000000000000000000000000000000000', 0n]
    const p = parseParticipant(result)

    expect(p.isWhitelisted).toBe(false)
    expect(p.invitesReceived).toBe(0)
    expect(p.committed).toBe(0n)
    expect(p.allocation).toBe(0n)
    expect(p.refund).toBe(0n)
    expect(p.claimed).toBe(false)
    expect(p.invitesSent).toBe(0)
  })

  it('converts invitesReceived and invitesSent from BigInt to number', () => {
    const result = [true, 3n, 1000n, 0n, 0n, false, '0x1', 5n]
    const p = parseParticipant(result)

    expect(typeof p.invitesReceived).toBe('number')
    expect(typeof p.invitesSent).toBe('number')
  })

  it('preserves committed/allocation/refund as bigint', () => {
    const result = [true, 0n, 15_000_000_000n, 12_000_000_000n, 3_000_000_000n, true, '0x1', 0n]
    const p = parseParticipant(result)

    expect(typeof p.committed).toBe('bigint')
    expect(typeof p.allocation).toBe('bigint')
    expect(typeof p.refund).toBe('bigint')
    expect(p.committed).toBe(15_000_000_000n)
    expect(p.allocation).toBe(12_000_000_000n)
    expect(p.refund).toBe(3_000_000_000n)
  })

  it('preserves boolean fields as booleans', () => {
    const result = [true, 0n, 0n, 0n, 0n, true, '0x1', 0n]
    const p = parseParticipant(result)

    expect(typeof p.isWhitelisted).toBe('boolean')
    expect(typeof p.claimed).toBe('boolean')
    expect(p.isWhitelisted).toBe(true)
    expect(p.claimed).toBe(true)
  })

  it('handles large USDC amounts (max cap $15,000)', () => {
    const maxCap = 15_000n * 1_000_000n // $15,000 in 6-decimal USDC
    const result = [true, 0n, maxCap, maxCap, 0n, false, '0x1', 3n]
    const p = parseParticipant(result)

    expect(p.committed).toBe(maxCap)
    expect(p.allocation).toBe(maxCap)
  })
})

describe('parseHopStats', () => {
  it('parses a hop stats struct', () => {
    const result = [800_000_000_000n, 5n, 10n]
    const s = parseHopStats(result)

    expect(s.totalCommitted).toBe(800_000_000_000n)
    expect(s.uniqueCommitters).toBe(5)
    expect(s.whitelistCount).toBe(10)
  })

  it('parses zero values', () => {
    const result = [0n, 0n, 0n]
    const s = parseHopStats(result)

    expect(s.totalCommitted).toBe(0n)
    expect(s.uniqueCommitters).toBe(0)
    expect(s.whitelistCount).toBe(0)
  })

  it('preserves totalCommitted as bigint', () => {
    const result = [1_200_000_000_000n, 100n, 150n]
    const s = parseHopStats(result)

    expect(typeof s.totalCommitted).toBe('bigint')
  })

  it('converts uniqueCommitters and whitelistCount to number', () => {
    const result = [0n, 42n, 99n]
    const s = parseHopStats(result)

    expect(typeof s.uniqueCommitters).toBe('number')
    expect(typeof s.whitelistCount).toBe('number')
    expect(s.uniqueCommitters).toBe(42)
    expect(s.whitelistCount).toBe(99)
  })
})
