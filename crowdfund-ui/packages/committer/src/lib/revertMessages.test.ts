// ABOUTME: Tests for the revert message mapping utility.
// ABOUTME: Verifies all known revert patterns map to human-readable messages.

import { describe, it, expect } from 'vitest'
import { mapRevertToMessage } from './revertMessages'

describe('mapRevertToMessage', () => {
  it('maps user rejection', () => {
    expect(mapRevertToMessage(new Error('user rejected transaction'))).toBe('Transaction rejected by user')
  })

  it('maps the submitWrite wrong-network guard error', () => {
    expect(mapRevertToMessage(new Error('Wrong network — switch to Ethereum and retry.'))).toBe(
      'Wrong network — switch to the hub chain in your wallet and retry.',
    )
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

  it('maps the contract "sale in refund mode" string', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: sale in refund mode'))).toBe(
      'No ARM allocations (refund mode). Use Claim Refund instead.',
    )
  })

  it('maps invalid signature', () => {
    expect(mapRevertToMessage(new Error('invalid signature'))).toBe('This invite link has an invalid signature.')
  })

  it('maps the contract "invalid invite signature" string', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: invalid invite signature'))).toBe(
      'This invite link has an invalid signature.',
    )
  })

  it('maps max invites received', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: max invites received'))).toBe(
      "You've already accepted the maximum number of invites for this hop.",
    )
  })

  it('maps "not active window" without being shadowed by "not active"', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: not active window'))).toBe(
      'Commitment window is not open.',
    )
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: not active'))).toBe(
      'Crowdfund is not in the active phase.',
    )
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

  it('maps window closed', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: window closed'))).toBe(
      'The commitment window has closed.',
    )
  })

  it('maps invite expired', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: invite expired'))).toBe(
      'This invite link has expired.',
    )
  })

  it('maps invite limit reached', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: invite limit reached'))).toBe(
      'The inviter has no remaining invite slots.',
    )
  })

  it('maps already whitelisted', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: already whitelisted'))).toBe(
      'This address is already invited.',
    )
  })

  it('maps max hop reached', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: max hop reached'))).toBe(
      'You are already at the deepest hop level.',
    )
  })

  it('maps OZ insufficient allowance', () => {
    expect(mapRevertToMessage(new Error('ERC20: insufficient allowance'))).toBe(
      'USDC approval is too low — approve and retry.',
    )
  })

  it('maps OZ transfer amount exceeds balance', () => {
    expect(mapRevertToMessage(new Error('ERC20: transfer amount exceeds balance'))).toBe(
      'Your USDC balance is insufficient.',
    )
  })

  it('maps a bare ethers CALL_EXCEPTION (missing revert data)', () => {
    expect(mapRevertToMessage(new Error('missing revert data'))).toBe(
      'The transaction was reverted by the contract.',
    )
    expect(mapRevertToMessage({ code: 'CALL_EXCEPTION', message: 'call revert exception' })).toBe(
      'The transaction was reverted by the contract.',
    )
  })

  it('handles string errors', () => {
    expect(mapRevertToMessage('deadline passed')).toBe('The commitment deadline has passed.')
  })

  it('returns a generic message for unknown errors (no raw leak)', () => {
    expect(mapRevertToMessage(new Error('something unexpected with 0xdeadbeef calldata'))).toBe(
      'Transaction failed',
    )
    expect(mapRevertToMessage(new Error('x'.repeat(300)))).toBe('Transaction failed')
  })
})
