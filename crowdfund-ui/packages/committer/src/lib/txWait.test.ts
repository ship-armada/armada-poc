// ABOUTME: Unit tests for transaction-wait timeout detection.
// ABOUTME: A timeout must be distinguishable from a revert so the UI says "pending", not "failed".
import { describe, it, expect } from 'vitest'
import { isTxTimeoutError, TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE } from './txWait'

describe('isTxTimeoutError', () => {
  it('detects the ethers v6 TIMEOUT error code', () => {
    expect(isTxTimeoutError({ code: 'TIMEOUT', message: 'wait for transaction timeout' })).toBe(true)
  })

  it('detects a timeout via message text', () => {
    // ethers v6 raises "wait for transaction timeout" on tx.wait(_, ms) expiry.
    expect(isTxTimeoutError(new Error('wait for transaction timeout'))).toBe(true)
  })

  it('does not flag a revert / other error as a timeout', () => {
    expect(isTxTimeoutError({ code: 'CALL_EXCEPTION', message: 'execution reverted' })).toBe(false)
    expect(isTxTimeoutError(new Error('insufficient allowance'))).toBe(false)
    expect(isTxTimeoutError(null)).toBe(false)
    expect(isTxTimeoutError(undefined)).toBe(false)
  })

  it('exposes a 120s wait budget and pending copy', () => {
    expect(TX_WAIT_TIMEOUT_MS).toBe(120_000)
    expect(TX_PENDING_MESSAGE).toMatch(/pending/i)
  })
})
