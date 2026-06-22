// ABOUTME: Tests for revert-selector decoding (S-L1) — Error(string) + Panic(uint256) + hex extraction.

import { describe, it, expect } from 'vitest'
import { encodeErrorResult } from 'viem'
import { decodeRevertData, extractRevertHex } from './revertSelectors'

const ABI = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const

describe('decodeRevertData (S-L1)', () => {
  it('decodes Error(string) to its reason', () => {
    const data = encodeErrorResult({ abi: ABI, errorName: 'Error', args: ['insufficient balance'] })
    expect(decodeRevertData(data)).toBe('insufficient balance')
  })

  it('maps a Panic code to a friendly reason', () => {
    const overflow = encodeErrorResult({ abi: ABI, errorName: 'Panic', args: [0x11n] })
    expect(decodeRevertData(overflow)).toBe('Arithmetic overflow or underflow.')
    const divzero = encodeErrorResult({ abi: ABI, errorName: 'Panic', args: [0x12n] })
    expect(decodeRevertData(divzero)).toBe('Division or modulo by zero.')
  })

  it('returns a generic message for an unknown Panic code', () => {
    const exotic = encodeErrorResult({ abi: ABI, errorName: 'Panic', args: [0x99n] })
    expect(decodeRevertData(exotic)).toMatch(/Contract panic \(code 153\)/)
  })

  it('returns null for an unknown custom-error selector', () => {
    expect(decodeRevertData('0xdeadbeef')).toBeNull()
  })

  it('returns null for non-hex / short input', () => {
    expect(decodeRevertData('execution reverted')).toBeNull()
    expect(decodeRevertData('0x12')).toBeNull()
  })
})

describe('extractRevertHex (S-L1)', () => {
  it('reads a top-level .data hex payload', () => {
    // Panic selector + short tail (kept short so the secret scanner doesn't read a 64-hex
    // payload as a private key — extractRevertHex only needs an 8+ hex match).
    expect(extractRevertHex({ data: '0x4e487b710011' })).toBe('0x4e487b710011')
  })

  it('walks the cause chain for nested revert data', () => {
    const err = new Error('call reverted') as Error & { cause?: unknown }
    err.cause = { data: '0x08c379a0deadbeef' }
    expect(extractRevertHex(err)).toBe('0x08c379a0deadbeef')
  })

  it('falls back to a hex blob embedded in the message', () => {
    expect(extractRevertHex(new Error('reverted: 0x4e487b71abcdef'))).toBe('0x4e487b71abcdef')
  })

  it('returns null when there is no hex payload', () => {
    expect(extractRevertHex(new Error('execution reverted'))).toBeNull()
  })
})
