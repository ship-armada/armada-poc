// ABOUTME: Unit tests for transaction-wait timeout detection.
// ABOUTME: A timeout must be distinguishable from a revert so the UI says "pending", not "failed".
import { describe, it, expect } from 'vitest'
import { isTxTimeoutError, isUserRejection, TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE } from './txWait'

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

describe('isUserRejection', () => {
  it('detects ethers ACTION_REJECTED and EIP-1193 4001', () => {
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true)
    expect(isUserRejection({ code: 4001 })).toBe(true)
  })

  it('detects rejection via message text', () => {
    expect(isUserRejection(new Error('MetaMask Tx Signature: User denied transaction'))).toBe(true)
    expect(isUserRejection(new Error('user rejected action'))).toBe(true)
  })

  it('does not flag a genuine failure', () => {
    expect(isUserRejection(new Error('execution reverted'))).toBe(false)
    expect(isUserRejection({ code: 'CALL_EXCEPTION' })).toBe(false)
    expect(isUserRejection(null)).toBe(false)
  })
})
