// ABOUTME: Tests the tier-wording helpers under the relaunch profile (CROWDFUND_PROFILE=relaunch via a module reset).
// ABOUTME: Participant-facing copy says "tier" / "MULTI-TIER" on the relaunch and "hop" / "MULTI-HOP" elsewhere.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type FormatModule = typeof import('./format.js')
let format: FormatModule

beforeAll(async () => {
  vi.stubEnv('CROWDFUND_PROFILE', 'relaunch')
  vi.resetModules()
  const constants = await import('./constants.js')
  expect(constants.CROWDFUND_PROFILE).toBe('relaunch')
  format = await import('./format.js')
})

afterAll(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('tier wording on the relaunch profile', () => {
  // WHY: copy built from these helpers ("fully committed for this tier", "across all your tiers")
  // must not say "hop" on the relaunch, which presents its hops as named tiers.
  it('says tier and MULTI-TIER', () => {
    expect(format.tierWord()).toBe('tier')
    expect(format.tierWord(true)).toBe('tiers')
    expect(format.multiTierTagLabel()).toBe('MULTI-TIER')
  })
})
