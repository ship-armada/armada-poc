// ABOUTME: Unit tests for the admin startup environment validation.
// ABOUTME: Covers the PROD non-local hard-fail matrix and the dev pass-through.
import { describe, it, expect } from 'vitest'
import { validateEnv } from './validateEnv'

const COMPLETE_PROD = {
  PROD: true,
  VITE_NETWORK: 'mainnet',
  VITE_CROWDFUND_PROFILE: 'mainnet',
  VITE_DEPLOYMENT_INSTANCE: 'launch1',
}

describe('validateEnv (admin)', () => {
  it('passes a fully configured production build', () => {
    expect(validateEnv(COMPLETE_PROD)).toEqual({ ok: true })
  })

  it('passes any dev build regardless of missing vars', () => {
    expect(validateEnv({ PROD: false })).toEqual({ ok: true })
    expect(validateEnv({})).toEqual({ ok: true })
  })

  it('skips validation for an explicit local PROD build', () => {
    expect(validateEnv({ PROD: true, VITE_NETWORK: 'local' })).toEqual({ ok: true })
  })

  it('fails a PROD build with VITE_NETWORK unset', () => {
    const result = validateEnv({ PROD: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_NETWORK'))).toBe(true)
    }
  })

  it('fails a PROD build with a blank VITE_NETWORK', () => {
    const result = validateEnv({ PROD: true, VITE_NETWORK: '   ' })
    expect(result.ok).toBe(false)
  })

  it('enforces the env on a mainnet build (not just sepolia)', () => {
    const result = validateEnv({ PROD: true, VITE_NETWORK: 'mainnet', VITE_DEPLOYMENT_INSTANCE: 'launch1' })
    // profile missing while instance set → must fail
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_CROWDFUND_PROFILE'))).toBe(true)
    }
  })

  it('requires VITE_CROWDFUND_PROFILE only when a deployment instance is set', () => {
    const withInstance = validateEnv({ ...COMPLETE_PROD, VITE_CROWDFUND_PROFILE: undefined })
    expect(withInstance.ok).toBe(false)
    if (!withInstance.ok) {
      expect(withInstance.errors.some((e) => e.includes('VITE_CROWDFUND_PROFILE'))).toBe(true)
    }

    const withoutInstance = validateEnv({
      ...COMPLETE_PROD,
      VITE_CROWDFUND_PROFILE: undefined,
      VITE_DEPLOYMENT_INSTANCE: undefined,
    })
    expect(withoutInstance).toEqual({ ok: true })
  })

  it('does not require WalletConnect or indexer vars (admin uses neither)', () => {
    // A sepolia build with only VITE_NETWORK set and no instance passes.
    expect(validateEnv({ PROD: true, VITE_NETWORK: 'sepolia' })).toEqual({ ok: true })
  })

  it('rejects a non-mainnet profile on a mainnet build', () => {
    const result = validateEnv({ PROD: true, VITE_NETWORK: 'mainnet', VITE_CROWDFUND_PROFILE: 'medi' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('mainnet must use the "mainnet" profile'))).toBe(true)
    }
  })

  it('allows an unset profile on a mainnet build (defaults to mainnet)', () => {
    expect(validateEnv({ PROD: true, VITE_NETWORK: 'mainnet' })).toEqual({ ok: true })
  })
})
