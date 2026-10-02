// ABOUTME: Unit tests for reading alert parameters (timing + addresses) from the crowdfund contract.
// ABOUTME: Uses a fake contract so the mapping and failure behavior are tested without an RPC.

import { describe, expect, it } from 'vitest'
import { readCrowdfundAlertParams } from './params.js'

const OPEN = 1_791_478_800n
const fakeCrowdfund = {
  windowStart: async () => OPEN,
  launchTeamInviteEnd: async () => OPEN + 7n * 86_400n,
  windowEnd: async () => OPEN + 21n * 86_400n,
  treasury: async () => '0x00000000000000000000000000000000000000Aa',
  usdc: async () => '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
}

describe('readCrowdfundAlertParams', () => {
  // WHY: hand-copied timestamps left at 0 made the deadline-passed rules fire from the first
  // run, and a blank treasury address made every run throw; the contract is the source of truth.
  it('maps the contract immutables onto the alert params', async () => {
    const { params, usdcAddress } = await readCrowdfundAlertParams(fakeCrowdfund, 1, '0xcrowdfund')
    expect(params).toEqual({
      chainId: 1,
      contractAddress: '0xcrowdfund',
      treasuryAddress: '0x00000000000000000000000000000000000000Aa',
      openTimestamp: 1_791_478_800,
      week1Deadline: 1_791_478_800 + 7 * 86_400,
      commitmentDeadline: 1_791_478_800 + 21 * 86_400,
    })
    expect(usdcAddress).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  })

  // WHY: a wrong contract address (no code) makes the read fail; the evaluator must fail
  // loudly rather than run with empty parameters.
  it('propagates a failed contract read', async () => {
    const broken = { ...fakeCrowdfund, windowEnd: async () => { throw new Error('could not decode result data') } }
    await expect(readCrowdfundAlertParams(broken, 1, '0xcrowdfund')).rejects.toThrow('could not decode result data')
  })
})
