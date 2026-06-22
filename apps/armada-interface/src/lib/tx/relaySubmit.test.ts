// ABOUTME: Tests for handleRelaySubmitError + extractDuplicateTxHash — DUPLICATE_TX hash recovery (T-M3/S-M1).

import { describe, it, expect } from 'vitest'
import { handleRelaySubmitError } from './relaySubmit'
import { RelayerError, extractDuplicateTxHash } from '../relayer'

const HASH = `0x${'ab'.repeat(32)}` as const

describe('extractDuplicateTxHash (T-M3/S-M1)', () => {
  it('pulls the hash out of a DUPLICATE_TX message', () => {
    const err = new RelayerError('DUPLICATE_TX', 409, `Duplicate transaction on chain 100 (already submitted as ${HASH})`)
    expect(extractDuplicateTxHash(err)).toBe(HASH)
  })

  it('returns null for a non-DUPLICATE_TX error', () => {
    expect(extractDuplicateTxHash(new RelayerError('SUBMISSION_FAILED', 500, `failed ${HASH}`))).toBeNull()
  })

  it('returns null when a DUPLICATE_TX message carries no hash (format drift)', () => {
    expect(extractDuplicateTxHash(new RelayerError('DUPLICATE_TX', 409, 'Duplicate transaction'))).toBeNull()
  })
})

describe('handleRelaySubmitError (T-M3/S-M1)', () => {
  const telem = { id: 'tx-1', kind: 'unshield-local' as const }

  it('recovers a DUPLICATE_TX hash into a pending RelayResponse instead of failing', () => {
    const err = new RelayerError('DUPLICATE_TX', 409, `already submitted as ${HASH}`)
    expect(handleRelaySubmitError(err, telem)).toEqual({ txHash: HASH, status: 'pending' })
  })

  it('rethrows a DUPLICATE_TX with no recoverable hash', () => {
    const err = new RelayerError('DUPLICATE_TX', 409, 'Duplicate transaction')
    expect(() => handleRelaySubmitError(err, telem)).toThrow(err)
  })

  it('rethrows other relayer errors (so the outer catch classifies them)', () => {
    const err = new RelayerError('GAS_ESTIMATION_FAILED', 422, 'gas estimation failed')
    expect(() => handleRelaySubmitError(err, telem)).toThrow(err)
  })

  it('rethrows non-RelayerError values unchanged', () => {
    const err = new Error('network down')
    expect(() => handleRelaySubmitError(err, telem)).toThrow('network down')
  })
})
