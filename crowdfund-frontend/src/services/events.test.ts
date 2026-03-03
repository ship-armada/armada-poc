// ABOUTME: Tests for the parseEventArgs function from events.ts.
// ABOUTME: Validates bigint-to-string conversion and passthrough of other types.
import { describe, it, expect } from 'vitest'
import { parseEventArgs } from './events'

describe('parseEventArgs', () => {
  it('converts bigint values to strings', () => {
    const parsed = {
      fragment: { inputs: [{ name: 'amount' }, { name: 'sender' }] },
      args: { amount: 1_000_000n, sender: '0xabc' } as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result.amount).toBe('1000000')
    expect(result.sender).toBe('0xabc')
  })

  it('passes through non-bigint values unchanged', () => {
    const parsed = {
      fragment: { inputs: [{ name: 'active' }, { name: 'count' }] },
      args: { active: true, count: 42 } as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result.active).toBe(true)
    expect(result.count).toBe(42)
  })

  it('returns empty object when there are no inputs', () => {
    const parsed = {
      fragment: { inputs: [] as Array<{ name: string }> },
      args: {} as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result).toEqual({})
  })

  it('handles zero bigint', () => {
    const parsed = {
      fragment: { inputs: [{ name: 'value' }] },
      args: { value: 0n } as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result.value).toBe('0')
  })

  it('handles large bigint values', () => {
    const largeAmount = 1_800_000_000_000n // $1.8M in 6-decimal USDC
    const parsed = {
      fragment: { inputs: [{ name: 'totalRaised' }] },
      args: { totalRaised: largeAmount } as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result.totalRaised).toBe('1800000000000')
  })

  it('handles mixed types in a single event', () => {
    const parsed = {
      fragment: {
        inputs: [
          { name: 'participant' },
          { name: 'hop' },
          { name: 'amount' },
          { name: 'inviter' },
        ],
      },
      args: {
        participant: '0x1234',
        hop: 1n,
        amount: 5_000_000_000n,
        inviter: '0x5678',
      } as Record<string, unknown>,
    }
    const result = parseEventArgs(parsed)

    expect(result.participant).toBe('0x1234')
    expect(result.hop).toBe('1')
    expect(result.amount).toBe('5000000000')
    expect(result.inviter).toBe('0x5678')
  })
})
