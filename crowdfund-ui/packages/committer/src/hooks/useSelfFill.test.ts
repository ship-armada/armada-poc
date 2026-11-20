// ABOUTME: Tests for the self-fill ("max out") visibility rule in useSelfFill.
// ABOUTME: The offer needs an open window, a provider, a plan that adds commits, and the profile's selfFill flag.

import { describe, it, expect } from 'vitest'
import { shouldShowMaxOut } from './useSelfFill'

const base = {
  windowOpen: true,
  hasProvider: true,
  planEligible: true,
  newCommitUsdc: 1_000n * 10n ** 6n,
  selfFillEnabled: true,
}

describe('shouldShowMaxOut', () => {
  it('shows the offer when every condition holds', () => {
    expect(shouldShowMaxOut(base)).toBe(true)
  })

  // WHY: on the relaunch a team wallet could otherwise self-invite into hop 2 and self-commit
  // $10k, and a Known contributor would get a "commit to cap" banner. The profile turns it off.
  it('hides the offer when the profile disables self-fill, even if a plan exists', () => {
    expect(shouldShowMaxOut({ ...base, selfFillEnabled: false })).toBe(false)
  })

  it('hides the offer outside the window, without a provider, or with nothing to add', () => {
    expect(shouldShowMaxOut({ ...base, windowOpen: false })).toBe(false)
    expect(shouldShowMaxOut({ ...base, hasProvider: false })).toBe(false)
    expect(shouldShowMaxOut({ ...base, planEligible: false })).toBe(false)
    expect(shouldShowMaxOut({ ...base, newCommitUsdc: 0n })).toBe(false)
  })
})
