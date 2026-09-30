// ABOUTME: Tests for the admin transaction flow's revert-reason → human-readable message mapping.
// ABOUTME: Match strings must track the contract's actual require() messages or the mapping never fires.

import { describe, it, expect } from 'vitest'
import { CROWDFUND_CONSTANTS } from '@armada/crowdfund-shared'
import { friendlyError } from './useTransactionFlow'

describe('friendlyError', () => {
  // WHY: ArmadaCrowdfund._addSeed reverts with "seed cap reached"; the count shown must
  // come from the active profile (180 mainnet, 25 medi), not a hardcoded number.
  it('maps the contract seed-cap revert using the profile seed cap', () => {
    expect(friendlyError(new Error('execution reverted: ArmadaCrowdfund: seed cap reached'))).toBe(
      `Maximum seed count (${CROWDFUND_CONSTANTS.MAX_SEEDS}) has been reached`,
    )
  })

  it('maps the launch-team invite window revert', () => {
    expect(friendlyError(new Error('ArmadaCrowdfund: outside launch-team invite window'))).toBe(
      'Launch team invite window has closed',
    )
  })
})
