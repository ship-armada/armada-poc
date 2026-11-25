// ABOUTME: Tests revert messages under the relaunch profile (mocked): the tier wording replaces "hop".
// ABOUTME: Launch 1 and medi keep their hop wording (revertMessages.test.ts).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return { ...actual, TIER_NOUN: actual.TIER_NOUN_BY_PROFILE.relaunch }
})

import { mapRevertToMessage } from './revertMessages'

describe('mapRevertToMessage on the relaunch profile', () => {
  // WHY: the relaunch presents hops as tiers; a failed transaction must not introduce "hop".
  it('words tier-related reverts in tiers', () => {
    expect(mapRevertToMessage(new Error('not whitelisted'))).toBe('You are not invited to this tier.')
    expect(mapRevertToMessage(new Error('invalid hop'))).toBe('You are not invited to this tier.')
    expect(mapRevertToMessage(new Error('no invites remaining'))).toBe('The inviter has no remaining invite slots at this tier.')
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: max invites received'))).toBe(
      "You've already accepted the maximum number of invites for this tier.",
    )
  })

  // WHY: Backer and Community contributors cannot invite at all on the relaunch, so "the deepest hop
  // level" would not explain why; say plainly that this account cannot invite here.
  it('explains a max-hop revert as not being able to invite at this tier', () => {
    expect(mapRevertToMessage(new Error('ArmadaCrowdfund: max hop reached'))).toBe("Your account can't invite at this tier.")
  })
})
