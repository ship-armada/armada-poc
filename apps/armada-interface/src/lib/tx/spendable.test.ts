// ABOUTME: Tests for assertSpendableForFeeOnTop (S-M5) — the submit-time amount+fee<=balance guard.

import { describe, it, expect } from 'vitest'
import { assertSpendableForFeeOnTop } from './spendable'

describe('assertSpendableForFeeOnTop (S-M5)', () => {
  it('passes when amount + fee fits within balance', () => {
    expect(() => assertSpendableForFeeOnTop({ amount: 8_000_000n, fee: 2_000_000n, balance: 10_000_000n })).not.toThrow()
  })

  it('passes at the exact boundary (amount + fee === balance)', () => {
    expect(() => assertSpendableForFeeOnTop({ amount: 8_000_000n, fee: 2_000_000n, balance: 10_000_000n })).not.toThrow()
    expect(() => assertSpendableForFeeOnTop({ amount: 9_000_000n, fee: 1_000_000n, balance: 10_000_000n })).not.toThrow()
  })

  it('throws when the fresh fee pushes amount + fee over balance', () => {
    // Input-time fee was lower so the user entered near-max; the fresh fee at submit tips it over.
    expect(() => assertSpendableForFeeOnTop({ amount: 9_500_000n, fee: 1_000_000n, balance: 10_000_000n }))
      .toThrow(/Insufficient balance/i)
  })

  it('surfaces the amount, fee, and balance in the message so the copy is actionable', () => {
    let msg = ''
    try {
      assertSpendableForFeeOnTop({ amount: 9_500_000n, fee: 1_000_000n, balance: 10_000_000n })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/relayer fee/i)
    expect(msg).toMatch(/9\.5/) // amount
    expect(msg).toMatch(/10/) // balance
  })
})
