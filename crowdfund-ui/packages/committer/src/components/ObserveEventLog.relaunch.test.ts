// ABOUTME: Tests the Details event log's descriptions under the relaunch profile (mocked): tier names, not "hop-N".
// ABOUTME: Covers invites, launch-team placements, commits and per-tier allocations.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@armada/crowdfund-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@armada/crowdfund-shared')>()
  return { ...actual, hopLabel: (hop: number) => actual.TIER_LABELS_BY_PROFILE.relaunch[hop] ?? `Hop-${hop}` }
})

import { formatEventData } from './ObserveEventLog'

const ev = (type: string, args: Record<string, unknown>) =>
  ({ type, blockNumber: 1, transactionHash: '0x1', logIndex: 0, args }) as never
const name = (a: string) => a

describe('ObserveEventLog descriptions on the relaunch profile', () => {
  // WHY: the event log is participant-facing; it names the tier ("Invited") like the rest of the UI.
  it('names the tier instead of hop-N', () => {
    expect(formatEventData(ev('Invited', { inviter: 'alice', invitee: 'bob', hop: 2 }), name)).toBe('alice → bob · Invited')
    expect(formatEventData(ev('LaunchTeamInvited', { invitee: 'bob', hop: 2 }), name)).toBe('LT → bob · Invited')
    expect(formatEventData(ev('Committed', { participant: 'bob', hop: 0, amount: 10_000_000_000n }), name)).toBe('bob · $10,000 · Known')
    expect(formatEventData(ev('AllocatedHop', { participant: 'bob', hop: 2, acceptedUsdc: 5_000_000_000n }), name)).toBe('bob · Invited · $5,000')
  })
})
