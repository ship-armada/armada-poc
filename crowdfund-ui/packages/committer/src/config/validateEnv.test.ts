// ABOUTME: Unit tests for the startup environment validation.
// ABOUTME: Covers the PROD/Sepolia hard-fail matrix and the dev pass-through.
import { describe, it, expect } from 'vitest'
import { validateEnv } from './validateEnv'

const COMPLETE_PROD = {
  PROD: true,
  VITE_NETWORK: 'sepolia',
  VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
  VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
  VITE_CROWDFUND_PROFILE: 'medi',
  VITE_DEPLOYMENT_INSTANCE: 'medi2',
}

describe('validateEnv', () => {
  it('passes a fully configured production build', () => {
    expect(validateEnv(COMPLETE_PROD)).toEqual({ ok: true })
  })

  it('passes any dev build regardless of missing vars', () => {
    expect(validateEnv({ PROD: false })).toEqual({ ok: true })
    expect(validateEnv({})).toEqual({ ok: true })
  })

  it('skips validation only for an explicit local PROD build', () => {
    expect(validateEnv({ PROD: true, VITE_NETWORK: 'local' })).toEqual({ ok: true })
  })

  it('enforces a mainnet PROD build, not just sepolia (H4)', () => {
    // mainnet was previously skipped; a mainnet build missing WalletConnect/indexer must fail.
    const result = validateEnv({ PROD: true, VITE_NETWORK: 'mainnet' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_WALLETCONNECT_PROJECT_ID'))).toBe(true)
      expect(result.errors.some((e) => e.includes('VITE_CROWDFUND_INDEXER_URL'))).toBe(true)
    }
  })

  it('passes a fully configured mainnet production build', () => {
    expect(
      validateEnv({
        PROD: true,
        VITE_NETWORK: 'mainnet',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
        VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
        VITE_CROWDFUND_PROFILE: 'mainnet',
        VITE_DEPLOYMENT_INSTANCE: 'launch1',
        VITE_EXPECTED_CROWDFUND_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a non-mainnet profile on a mainnet build', () => {
    const result = validateEnv({
      PROD: true,
      VITE_NETWORK: 'mainnet',
      VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
      VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
      VITE_CROWDFUND_PROFILE: 'medi',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('mainnet must use the "mainnet" profile'))).toBe(true)
    }
  })

  it('allows an unset profile on a mainnet build (defaults to mainnet)', () => {
    expect(
      validateEnv({
        PROD: true,
        VITE_NETWORK: 'mainnet',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
        VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
        VITE_EXPECTED_CROWDFUND_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
      }),
    ).toEqual({ ok: true })
  })

  it('fails a mainnet build without VITE_EXPECTED_CROWDFUND_ADDRESS', () => {
    const result = validateEnv({
      PROD: true,
      VITE_NETWORK: 'mainnet',
      VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
      VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_EXPECTED_CROWDFUND_ADDRESS'))).toBe(true)
    }
  })

  it('does not require VITE_EXPECTED_CROWDFUND_ADDRESS on a sepolia build', () => {
    // COMPLETE_PROD is a sepolia build with no expected-address var; must stay green.
    expect(validateEnv(COMPLETE_PROD)).toEqual({ ok: true })
    expect(
      validateEnv({ ...COMPLETE_PROD, VITE_EXPECTED_CROWDFUND_ADDRESS: undefined }),
    ).toEqual({ ok: true })
  })

  it('fails a PROD build with VITE_NETWORK unset', () => {
    const result = validateEnv({ PROD: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_NETWORK'))).toBe(true)
    }
  })

  it('fails when VITE_WALLETCONNECT_PROJECT_ID is missing', () => {
    const result = validateEnv({ ...COMPLETE_PROD, VITE_WALLETCONNECT_PROJECT_ID: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_WALLETCONNECT_PROJECT_ID'))).toBe(true)
    }
  })

  it('fails when VITE_CROWDFUND_INDEXER_URL is missing', () => {
    const result = validateEnv({ ...COMPLETE_PROD, VITE_CROWDFUND_INDEXER_URL: '   ' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('VITE_CROWDFUND_INDEXER_URL'))).toBe(true)
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

  it('reports every missing var at once for an empty PROD build', () => {
    const result = validateEnv({ PROD: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // VITE_NETWORK, WalletConnect id, and indexer url are all missing.
      expect(result.errors.length).toBeGreaterThanOrEqual(3)
    }
  })
})
