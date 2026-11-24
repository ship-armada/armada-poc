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
        VITE_HUB_RPC: 'https://rpc.example',
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
      expect(result.errors.some((e) => e.includes('mainnet must use the "mainnet" or "relaunch" profile'))).toBe(true)
    }
  })

  // WHY: the relaunch crowdfund is on mainnet with its own constants; a relaunch build must not be
  // refused just because the network is mainnet.
  it('passes a fully configured mainnet production build on the relaunch profile', () => {
    expect(
      validateEnv({
        PROD: true,
        VITE_NETWORK: 'mainnet',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
        VITE_HUB_RPC: 'https://rpc.example',
        VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
        VITE_CROWDFUND_PROFILE: 'relaunch',
        VITE_DEPLOYMENT_INSTANCE: 'relaunch1',
        VITE_EXPECTED_CROWDFUND_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
      }),
    ).toEqual({ ok: true })
  })

  // WHY: an unknown profile name silently falls back to the mainnet (Launch 1) constants, so a typo
  // like "relaunh" would render the wrong sale. Production builds must refuse it on any network.
  it('rejects an unknown profile name on a production build', () => {
    const result = validateEnv({ ...COMPLETE_PROD, VITE_CROWDFUND_PROFILE: 'relaunh' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('"relaunh" is not a known profile'))).toBe(true)
    }
  })

  it('allows an unset profile on a mainnet build (defaults to mainnet)', () => {
    expect(
      validateEnv({
        PROD: true,
        VITE_NETWORK: 'mainnet',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
        VITE_HUB_RPC: 'https://rpc.example',
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

  it('rejects a malformed VITE_EXPECTED_CROWDFUND_ADDRESS on any network', () => {
    const mainnet = validateEnv({
      PROD: true,
      VITE_NETWORK: 'mainnet',
      VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
      VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
      VITE_EXPECTED_CROWDFUND_ADDRESS: '0x123',
    })
    expect(mainnet.ok).toBe(false)
    if (!mainnet.ok) {
      expect(mainnet.errors.some((e) => e.includes('not a valid Ethereum address'))).toBe(true)
    }
    // Also enforced when opted into on sepolia.
    const sepolia = validateEnv({ ...COMPLETE_PROD, VITE_EXPECTED_CROWDFUND_ADDRESS: 'nope' })
    expect(sepolia.ok).toBe(false)
  })

  it('accepts a lowercase (non-checksummed) VITE_EXPECTED_CROWDFUND_ADDRESS', () => {
    // Format-only check — a lowercase-entered address must not be rejected.
    expect(
      validateEnv({
        PROD: true,
        VITE_NETWORK: 'mainnet',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
        VITE_HUB_RPC: 'https://rpc.example',
        VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
        VITE_EXPECTED_CROWDFUND_ADDRESS: '0x52908400098527886e0f7030069857d2e4169ee7',
      }),
    ).toEqual({ ok: true })
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

  describe('pre-launch mode (VITE_PRELAUNCH_OPENS_AT)', () => {
    // What the fund.armada.blue site sets before the contracts exist: no
    // indexer, no manifest, no expected crowdfund address.
    const PRELAUNCH_MAINNET = {
      PROD: true,
      VITE_NETWORK: 'mainnet',
      VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
      VITE_HUB_RPC: 'https://rpc.example',
      VITE_CROWDFUND_PROFILE: 'mainnet',
      VITE_PRELAUNCH_OPENS_AT: '2026-10-08T17:00:00Z',
    }

    it('passes a mainnet pre-launch build without indexer or expected crowdfund address', () => {
      expect(validateEnv(PRELAUNCH_MAINNET)).toEqual({ ok: true })
    })

    it('still enforces the network, WalletConnect id and mainnet profile', () => {
      const result = validateEnv({
        ...PRELAUNCH_MAINNET,
        VITE_WALLETCONNECT_PROJECT_ID: undefined,
        VITE_CROWDFUND_PROFILE: 'medi',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_WALLETCONNECT_PROJECT_ID'))).toBe(true)
        expect(result.errors.some((e) => e.includes('mainnet must use the "mainnet" or "relaunch" profile'))).toBe(true)
      }
      const noNetwork = validateEnv({ ...PRELAUNCH_MAINNET, VITE_NETWORK: undefined })
      expect(noNetwork.ok).toBe(false)
    })

    it('rejects a malformed opening time in PROD', () => {
      const result = validateEnv({ ...PRELAUNCH_MAINNET, VITE_PRELAUNCH_OPENS_AT: '1791478800' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_PRELAUNCH_OPENS_AT'))).toBe(true)
      }
    })

    it('rejects a malformed opening time in dev too, so a typo surfaces before deploy', () => {
      const result = validateEnv({ PROD: false, VITE_PRELAUNCH_OPENS_AT: '2026-10-08' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_PRELAUNCH_OPENS_AT'))).toBe(true)
      }
    })

    it('treats a blank value as pre-launch off (live requirements apply)', () => {
      const result = validateEnv({ ...PRELAUNCH_MAINNET, VITE_PRELAUNCH_OPENS_AT: '  ' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_CROWDFUND_INDEXER_URL'))).toBe(true)
        expect(result.errors.some((e) => e.includes('VITE_EXPECTED_CROWDFUND_ADDRESS'))).toBe(true)
      }
    })
  })

  it('reports every missing var at once for an empty PROD build', () => {
    const result = validateEnv({ PROD: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // VITE_NETWORK, WalletConnect id, and indexer url are all missing.
      expect(result.errors.length).toBeGreaterThanOrEqual(3)
    }
  })

  describe('first-sale refunds (VITE_REFUND_ONLY_CROWDFUND_ADDRESS, VITE_HUB_RPC)', () => {
    const MAINNET_LIVE = {
      PROD: true,
      VITE_NETWORK: 'mainnet',
      VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
      VITE_HUB_RPC: 'https://rpc.example',
      VITE_CROWDFUND_INDEXER_URL: 'https://indexer.example',
      VITE_CROWDFUND_PROFILE: 'relaunch',
      VITE_EXPECTED_CROWDFUND_ADDRESS: '0x52908400098527886E0F7030069857D2E4169EE7',
    }
    const SALE1 = '0xB4b0BBac50Df6c9479180AA788dAd8f88D520163'
    const LOCAL_TARGET = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

    // WHY: mainnet builds always offer first-sale refunds (the /refund page reads the chain, even
    // in pre-launch mode), so they need a dedicated RPC rather than the public fallback.
    it('requires VITE_HUB_RPC on a mainnet build, live or pre-launch', () => {
      for (const env of [
        { ...MAINNET_LIVE, VITE_HUB_RPC: undefined },
        {
          PROD: true,
          VITE_NETWORK: 'mainnet',
          VITE_WALLETCONNECT_PROJECT_ID: 'wc-id',
          VITE_PRELAUNCH_OPENS_AT: '2026-12-01T17:00:00Z',
        },
      ]) {
        const result = validateEnv(env)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.errors.some((e) => e.includes('VITE_HUB_RPC'))).toBe(true)
      }
    })

    // WHY: on mainnet the refund target is the built-in Sale 1 address; a Netlify setting that
    // tries to change it is a misconfiguration (or an attack), not an override.
    it('rejects VITE_REFUND_ONLY_CROWDFUND_ADDRESS on a mainnet build', () => {
      const result = validateEnv({ ...MAINNET_LIVE, VITE_REFUND_ONLY_CROWDFUND_ADDRESS: LOCAL_TARGET })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_REFUND_ONLY_CROWDFUND_ADDRESS'))).toBe(true)
      }
    })

    // WHY: the live app pointed at the cancelled first sale would invite commits into a dead contract.
    it('rejects a mainnet build whose expected crowdfund is the first-sale contract', () => {
      const result = validateEnv({ ...MAINNET_LIVE, VITE_EXPECTED_CROWDFUND_ADDRESS: SALE1.toLowerCase() })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.some((e) => e.includes('first-sale'))).toBe(true)
    })

    it('accepts a valid override on a sepolia build', () => {
      expect(validateEnv({ ...COMPLETE_PROD, VITE_REFUND_ONLY_CROWDFUND_ADDRESS: LOCAL_TARGET })).toEqual({ ok: true })
    })

    // WHY: a typo would silently turn the rehearsal's refund panel off.
    it('rejects a malformed override', () => {
      const result = validateEnv({ ...COMPLETE_PROD, VITE_REFUND_ONLY_CROWDFUND_ADDRESS: '0x1234' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes('VITE_REFUND_ONLY_CROWDFUND_ADDRESS'))).toBe(true)
      }
    })

    // WHY: the refund target must be the old sale, never the one being committed to.
    it('rejects an override equal to the expected crowdfund address', () => {
      const result = validateEnv({
        ...COMPLETE_PROD,
        VITE_EXPECTED_CROWDFUND_ADDRESS: LOCAL_TARGET,
        VITE_REFUND_ONLY_CROWDFUND_ADDRESS: LOCAL_TARGET.toLowerCase(),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.some((e) => e.includes('same as'))).toBe(true)
    })
  })
})
