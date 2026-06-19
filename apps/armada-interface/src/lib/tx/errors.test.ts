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

describe('classifyHandlerError — RelayerError branch (S-H2)', () => {
  /** Duck-typed RelayerError matching lib/relayer's shape (name + code). */
  function relayerError(code: string, message = 'relayer said no') {
    return Object.assign(new Error(message), { name: 'RelayerError', code })
  }

  it('maps pre-broadcast refusals to PRE_FLIGHT_REVERT (nothing was sent)', () => {
    // WHY (S-H2): GAS_ESTIMATION_FAILED / INVALID_* mean the relayer refused before submitting.
    // Pre-flight semantics tell the user no gas was spent and nothing left their wallet.
    for (const code of ['GAS_ESTIMATION_FAILED', 'INVALID_TARGET', 'INVALID_CHAIN', 'INVALID_DATA']) {
      expect(classifyHandlerError(relayerError(code), 'fallback').code).toBe('PRE_FLIGHT_REVERT')
    }
  })

  it('maps fee-quote rejections to FEE_EXPIRED with start-over copy', () => {
    // WHY (S-H2/S-H1): the cacheId + fee are frozen into the proof, so a retry re-POSTs the same
    // doomed quote. Distinct code lets S-H1 gate retry off and surface "start a new transaction".
    for (const code of ['FEE_TOO_LOW', 'FEE_EXPIRED', 'FEE_INSUFFICIENT']) {
      const r = classifyHandlerError(relayerError(code), 'fallback')
      expect(r.code).toBe('FEE_EXPIRED')
      expect(r.message).toMatch(/new transaction|fresh quote/i)
    }
  })

  it('maps DUPLICATE_TX (409) to DUPLICATE_TX, not a generic failure', () => {
    // WHY (S-H2): a 409 means the tx WAS submitted; surfacing it as an opaque failure is wrong.
    expect(classifyHandlerError(relayerError('DUPLICATE_TX'), 'fallback').code).toBe('DUPLICATE_TX')
  })

  it('maps transient relayer states (busy / submission failed) to RPC_ERROR', () => {
    // WHY (S-H2): RELAYER_BUSY / SUBMISSION_FAILED are transient and retry-appropriate.
    expect(classifyHandlerError(relayerError('RELAYER_BUSY'), 'fallback').code).toBe('RPC_ERROR')
    expect(classifyHandlerError(relayerError('SUBMISSION_FAILED'), 'fallback').code).toBe('RPC_ERROR')
  })

  it('falls through to OTHER for UNKNOWN_ERROR, preserving the message', () => {
    const r = classifyHandlerError(relayerError('UNKNOWN_ERROR', 'weird relayer state'), 'fallback')
    expect(r.code).toBe('OTHER')
    expect(r.message).toBe('weird relayer state')
  })
})

describe('classifyHandlerError — ChainMismatchError branch (W-4)', () => {
  /** viem throws a `ChainMismatchError` when a wagmi action is given an explicit chainId that
   *  doesn't match the wallet's current chain. We pin chainId on every submit-path call now
   *  (W-3/W-4), so a mid-flow network switch surfaces this instead of silently following the
   *  wrong chain — the classifier turns it into actionable "switch back" copy. */
  function chainMismatch(message = 'The current chain of the wallet (id: 11155111) does not match the target chain for the transaction (id: 31337).') {
    return Object.assign(new Error(message), { name: 'ChainMismatchError' })
  }

  it('maps a ChainMismatchError to RPC_ERROR (pre-broadcast, retry-safe after switching back)', () => {
    expect(classifyHandlerError(chainMismatch(), 'fallback').code).toBe('RPC_ERROR')
  })

  it('names the target network in the copy when the target chainId is known', () => {
    const r = classifyHandlerError(chainMismatch(), 'fallback', undefined, 31337)
    expect(r.message).toMatch(/switch/i)
    expect(r.message).toContain('Anvil Hub (local)') // getChainById(31337).name
  })

  it('falls back to generic switch-network copy when no target chainId is supplied', () => {
    const r = classifyHandlerError(chainMismatch(), 'fallback')
    expect(r.message).toMatch(/wrong network/i)
    expect(r.message).toMatch(/switch/i)
  })

  it('recurses into .cause for a wrapped ChainMismatchError', () => {
    const inner = chainMismatch()
    const outer = new Error('write failed') as Error & { cause: unknown }
    outer.cause = inner
    expect(classifyHandlerError(outer, 'fallback', undefined, 31337).code).toBe('RPC_ERROR')
  })
})
