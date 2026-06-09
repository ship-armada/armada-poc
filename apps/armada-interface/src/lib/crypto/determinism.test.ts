// ABOUTME: Tests for lib/crypto/determinism — NonDeterministicSignerError shape + verifySignatureDeterminism comparison.

import { describe, it, expect, vi } from 'vitest'
import {
  NonDeterministicSignerError,
  isNonDeterministicSignerError,
  verifySignatureDeterminism,
} from './determinism'

function fixedSignature(seed: number = 0): Uint8Array {
  const out = new Uint8Array(65)
  for (let i = 0; i < 64; i++) out[i] = (seed + i) & 0xff
  out[64] = 27
  return out
}

describe('NonDeterministicSignerError', () => {
  it('carries the discriminator + reason + default message', () => {
    const err = new NonDeterministicSignerError('first-sign-mismatch')
    expect(err.kind).toBe('NonDeterministicSignerError')
    expect(err.reason).toBe('first-sign-mismatch')
    expect(err.message).toMatch(/deterministic wallet/i)
    expect(err.name).toBe('NonDeterministicSignerError')
  })

  it('preserves instanceof under the constructor prototype fix', () => {
    const err = new NonDeterministicSignerError('cached-checksum-mismatch')
    expect(err).toBeInstanceOf(NonDeterministicSignerError)
    expect(err).toBeInstanceOf(Error)
  })

  it('accepts an override message', () => {
    const err = new NonDeterministicSignerError('first-sign-mismatch', 'custom copy')
    expect(err.message).toBe('custom copy')
  })

  it('emits cached-checksum-mismatch copy that points at paste/backup recovery', () => {
    const err = new NonDeterministicSignerError('cached-checksum-mismatch')
    expect(err.message).toMatch(/Paste recovery secret|backup file/i)
  })
})

describe('isNonDeterministicSignerError', () => {
  it('returns true for thrown errors', () => {
    const err = new NonDeterministicSignerError('first-sign-mismatch')
    expect(isNonDeterministicSignerError(err)).toBe(true)
  })

  it('returns true for cross-bundle objects carrying the kind discriminator', () => {
    // Simulates the object reaching a different module/realm where instanceof might fail.
    const fake = { kind: 'NonDeterministicSignerError', reason: 'first-sign-mismatch', message: 'x' }
    expect(isNonDeterministicSignerError(fake)).toBe(true)
  })

  it('returns false for plain Errors and non-matching kinds', () => {
    expect(isNonDeterministicSignerError(new Error('nope'))).toBe(false)
    expect(isNonDeterministicSignerError({ kind: 'SomethingElse' })).toBe(false)
    expect(isNonDeterministicSignerError(null)).toBe(false)
    expect(isNonDeterministicSignerError(undefined)).toBe(false)
    expect(isNonDeterministicSignerError('string error')).toBe(false)
  })
})

describe('verifySignatureDeterminism', () => {
  it('returns deterministic=true when both signatures are byte-identical', async () => {
    const sig = fixedSignature(0)
    const reSign = vi.fn(async () => fixedSignature(0))
    const result = await verifySignatureDeterminism(reSign, sig)
    expect(result.deterministic).toBe(true)
    expect(reSign).toHaveBeenCalledTimes(1)
  })

  it('returns deterministic=false when the second signature differs', async () => {
    const first = fixedSignature(0)
    const second = fixedSignature(1) // different seed → different bytes
    const reSign = vi.fn(async () => second)
    const result = await verifySignatureDeterminism(reSign, first)
    expect(result.deterministic).toBe(false)
  })

  it('detects a single-byte difference (rigorous byte-equal comparison)', async () => {
    const first = fixedSignature(0)
    const second = new Uint8Array(first)
    second[32] = (second[32]! + 1) & 0xff // flip one byte mid-s
    const reSign = vi.fn(async () => second)
    const result = await verifySignatureDeterminism(reSign, first)
    expect(result.deterministic).toBe(false)
  })

  it('rejects malformed first-signature length up front', async () => {
    const reSign = vi.fn(async () => fixedSignature())
    await expect(verifySignatureDeterminism(reSign, new Uint8Array(64))).rejects.toThrow()
    expect(reSign).not.toHaveBeenCalled()
  })

  it('rejects malformed second-signature length from the callback', async () => {
    const first = fixedSignature(0)
    const reSign = vi.fn(async () => new Uint8Array(64))
    await expect(verifySignatureDeterminism(reSign, first)).rejects.toThrow()
  })

  it('does not throw on non-determinism — caller is responsible for the typed error', async () => {
    // Important: the function is split this way so it can be unit-tested without try/catch
    // wrapping. The hook code throws NonDeterministicSignerError; this helper just reports.
    const reSign = vi.fn(async () => fixedSignature(1))
    const out = await verifySignatureDeterminism(reSign, fixedSignature(0))
    expect(out.deterministic).toBe(false)
    expect(() => out).not.toThrow()
  })
})
