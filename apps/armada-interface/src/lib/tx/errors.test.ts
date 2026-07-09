// ABOUTME: Tests for classifyHandlerError — branded TxError pass-through, user-rejection detection, OTHER fallback with txHash forwarding.

import { describe, it, expect } from 'vitest'
import { classifyHandlerError } from './errors'
import { asTxError } from './receipt'

describe('classifyHandlerError', () => {
  it('passes a branded TxError through unchanged so categorisation isn\'t lost in the outer catch', () => {
    // The whole point: an inner helper (e.g. waitForReceiptOrFail) classifies a POLL_TIMEOUT or
    // TX_REVERTED with its own txHash. If the outer try re-classifies as OTHER we'd lose the
    // category AND the txHash, defeating the typed-error system.
    const branded = asTxError({ code: 'POLL_TIMEOUT', message: 'inner timeout', txHash: '0xabc' })
    const result = classifyHandlerError(branded, 'should not be used')
    expect(result).toEqual({ code: 'POLL_TIMEOUT', message: 'inner timeout', txHash: '0xabc' })
  })

  it('classifies viem-style UserRejectedRequestError as USER_REJECTED', () => {
    const err = { name: 'UserRejectedRequestError', message: 'user denied' }
    expect(classifyHandlerError(err, 'fallback').code).toBe('USER_REJECTED')
  })

  it('classifies MetaMask code 4001 as USER_REJECTED', () => {
    const err = { code: 4001, message: 'rejected' }
    expect(classifyHandlerError(err, 'fallback').code).toBe('USER_REJECTED')
  })

  it('classifies ethers ACTION_REJECTED as USER_REJECTED', () => {
    const err = { code: 'ACTION_REJECTED' }
    expect(classifyHandlerError(err, 'fallback').code).toBe('USER_REJECTED')
  })

  it('recurses into .cause for viem-wrapped rejections', () => {
    const inner = Object.assign(new Error('User rejected'), { code: 4001 })
    const outer = new Error('Outer failure') as Error & { cause: unknown }
    outer.cause = inner
    expect(classifyHandlerError(outer, 'fallback').code).toBe('USER_REJECTED')
  })

  it('falls through to OTHER, preserving an unrecognized message verbatim', () => {
    const err = new Error('some unrecognized handler failure')
    const result = classifyHandlerError(err, 'fallback')
    expect(result.code).toBe('OTHER')
    expect(result.message).toBe('some unrecognized handler failure')
  })

  it('maps a known revert pattern to friendly copy via mapRevertToMessage (P2)', () => {
    const result = classifyHandlerError(new Error('execution reverted: insufficient funds for gas'), 'fallback')
    expect(result.code).toBe('OTHER')
    expect(result.message).toBe('Insufficient funds for gas')
  })

  it('truncates a multi-line viem dump at 200 chars so it does not reach ErrorStep verbatim (P2)', () => {
    const long = 'x'.repeat(500)
    const result = classifyHandlerError(new Error(long), 'fallback')
    expect(result.code).toBe('OTHER')
    expect(result.message.length).toBeLessThanOrEqual(201) // 200 chars + the ellipsis
    expect(result.message.endsWith('…')).toBe(true)
  })

  it('uses the fallback message when the thrown value has none', () => {
    const result = classifyHandlerError('not an error', 'Handler failed.')
    expect(result.code).toBe('OTHER')
    expect(result.message).toBe('Handler failed.')
  })

  it('attaches the sourceTxHash when supplied — only on OTHER (USER_REJECTED has no relevant hash)', () => {
    // Handler catches typically know the sourceTxHash at the point they classify; passing it in
    // means OTHER errors can still surface an explorer link in the UI.
    const result = classifyHandlerError(new Error('gas estimation failed'), 'fallback', '0xdeadbeef' as `0x${string}`)
    expect(result.code).toBe('OTHER')
    expect(result.txHash).toBe('0xdeadbeef')
  })

  it('does NOT overwrite a branded error\'s txHash with the outer-context hash', () => {
    // Subtle case: inner helper threw POLL_TIMEOUT with txHash=0xabc; outer catch knows about a
    // different hash (e.g. the user retried with a fresh submission and 0xfed is the new hash).
    // The branded txHash from the inner classifier wins — it reflects what actually timed out.
    const branded = asTxError({ code: 'POLL_TIMEOUT', message: 'inner timed out', txHash: '0xabc' })
    const result = classifyHandlerError(branded, 'fallback', '0xfed' as `0x${string}`)
    expect(result.txHash).toBe('0xabc')
  })
})
