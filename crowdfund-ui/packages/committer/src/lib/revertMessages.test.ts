// ABOUTME: Tests for the revert message mapping utility.
// ABOUTME: Verifies all known revert patterns map to human-readable messages.

import { describe, it, expect } from 'vitest'
import { mapRevertToMessage } from './revertMessages'

describe('mapRevertToMessage', () => {
  it('maps user rejection', () => {
    expect(mapRevertToMessage(new Error('user rejected transaction'))).toBe('Transaction rejected by user')
  })

  it('maps deadline passed', () => {
    expect(mapRevertToMessage(new Error('deadline passed'))).toBe('The commitment deadline has passed.')
  })

  it('maps cancelled', () => {
    expect(mapRevertToMessage(new Error('execution reverted: cancelled'))).toBe('This crowdfund has been cancelled.')
  })

  it('maps already finalized', () => {
    expect(mapRevertToMessage(new Error('already finalized'))).toBe('This crowdfund has already been finalized.')
  })

  it('maps ARM not loaded', () => {
    expect(mapRevertToMessage(new Error('ARM not loaded'))).toBe('The crowdfund has not opened yet.')
  })

  it('maps not whitelisted', () => {
    expect(mapRevertToMessage(new Error('not whitelisted'))).toBe('You are not invited to this hop level.')
  })

  it('maps already claimed', () => {
    expect(mapRevertToMessage(new Error('already claimed'))).toBe('You have already claimed this.')
  })

  it('maps claim expired', () => {
    expect(mapRevertToMessage(new Error('claim expired'))).toBe('The 3-year claim deadline has passed.')
  })

  it('maps refundMode', () => {
    expect(mapRevertToMessage(new Error('refundMode'))).toBe('No ARM allocations (refund mode). Use Claim Refund instead.')
  })

  it('maps invalid signature', () => {
    expect(mapRevertToMessage(new Error('invalid signature'))).toBe('This invite link has an invalid signature.')
  })

  it('maps nonce consumed', () => {
    expect(mapRevertToMessage(new Error('nonce consumed'))).toBe('This invite link has already been used.')
  })

  it('maps nonce revoked', () => {
    expect(mapRevertToMessage(new Error('nonce revoked'))).toBe('This invite link has been revoked.')
  })

  it('maps no invites remaining', () => {
    expect(mapRevertToMessage(new Error('no invites remaining'))).toBe('The inviter has no remaining invite slots at this hop.')
  })

  it('maps insufficient balance', () => {
    expect(mapRevertToMessage(new Error('insufficient balance'))).toBe('Your USDC balance is insufficient.')
  })

  it('truncates long unknown errors', () => {
    const longMsg = 'x'.repeat(300)
    const result = mapRevertToMessage(new Error(longMsg))
    expect(result).toHaveLength(203) // 200 + '...'
  })

  it('handles string errors', () => {
    expect(mapRevertToMessage('deadline passed')).toBe('The commitment deadline has passed.')
  })

  it('returns raw message for unknown errors', () => {
    expect(mapRevertToMessage(new Error('something unexpected'))).toBe('something unexpected')
  })
})
