// ABOUTME: Tests for the shared isUserRejection predicate (P1-17) — the single source of truth used by network-switch, the tx classifier, and enrollment copy.

import { describe, it, expect } from 'vitest'
import { isUserRejection } from './errors'

describe('isUserRejection', () => {
  it('detects EIP-1193 code 4001', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true)
  })

  it('detects ACTION_REJECTED + UserRejectedRequestError name', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true)
    expect(isUserRejection({ name: 'UserRejectedRequestError' })).toBe(true)
  })

  it('detects rejected/denied/cancelled message variants', () => {
    expect(isUserRejection(new Error('User rejected the request.'))).toBe(true)
    expect(isUserRejection(new Error('user denied transaction signature'))).toBe(true)
    expect(isUserRejection(new Error('User cancelled the request'))).toBe(true)
  })

  it('recurses one level into .cause (viem wrapping)', () => {
    expect(isUserRejection({ message: 'outer', cause: { code: 4001 } })).toBe(true)
  })

  it('returns false for unrelated errors and nullish input', () => {
    expect(isUserRejection(new Error('insufficient funds'))).toBe(false)
    expect(isUserRejection(null)).toBe(false)
    expect(isUserRejection(undefined)).toBe(false)
  })
})
