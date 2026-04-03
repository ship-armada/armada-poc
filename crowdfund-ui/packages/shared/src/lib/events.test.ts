// ABOUTME: Unit tests for crowdfund event parsing.
// ABOUTME: Verifies parseCrowdfundEvent handles all 12 event types and edge cases.

import { describe, it, expect } from 'vitest'
import { Interface } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from './constants.js'
import { parseCrowdfundEvent, parseCrowdfundEvents } from './events.js'

const iface = new Interface(CROWDFUND_ABI_FRAGMENTS)

/** Encode a log for a given event name and args */
function encodeLog(
  eventName: string,
  args: unknown[],
  overrides?: { blockNumber?: number; transactionHash?: string; logIndex?: number },
) {
  const fragment = iface.getEvent(eventName)
  if (!fragment) throw new Error(`Unknown event: ${eventName}`)
  const log = iface.encodeEventLog(fragment, args)
  return {
    blockNumber: overrides?.blockNumber ?? 100,
    transactionHash: overrides?.transactionHash ?? '0x' + 'ab'.repeat(32),
    logIndex: overrides?.logIndex ?? 0,
    topics: log.topics as string[],
    data: log.data,
  }
}

describe('parseCrowdfundEvent', () => {
  it('parses ArmLoaded event', () => {
    const log = encodeLog('ArmLoaded', [])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('ArmLoaded')
    expect(result!.blockNumber).toBe(100)
    expect(result!.args).toEqual({})
  })

  it('parses SeedAdded event', () => {
    const seed = '0x' + '11'.repeat(20)
    const log = encodeLog('SeedAdded', [seed])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('SeedAdded')
    expect(result!.args.seed).toBe(seed.toLowerCase())
  })

  it('parses Invited event', () => {
    const inviter = '0x' + '22'.repeat(20)
    const invitee = '0x' + '33'.repeat(20)
    const log = encodeLog('Invited', [inviter, invitee, 1, 42n])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('Invited')
    expect(result!.args.inviter).toBe(inviter.toLowerCase())
    expect(result!.args.invitee).toBe(invitee.toLowerCase())
    expect(result!.args.hop).toBe(1n)
    expect(result!.args.nonce).toBe(42n)
  })

  it('parses LaunchTeamInvited event', () => {
    const invitee = '0x' + '33'.repeat(20)
    const log = encodeLog('LaunchTeamInvited', [invitee, 1])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('LaunchTeamInvited')
    expect(result!.args.invitee).toBe(invitee.toLowerCase())
    expect(result!.args.hop).toBe(1n)
  })

  it('parses Committed event', () => {
    const participant = '0x' + '44'.repeat(20)
    const amount = 5_000n * 10n ** 6n
    const log = encodeLog('Committed', [participant, 0, amount])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('Committed')
    expect(result!.args.participant).toBe(participant.toLowerCase())
    expect(result!.args.hop).toBe(0n)
    expect(result!.args.amount).toBe(amount)
  })

  it('parses Finalized event', () => {
    const saleSize = 1_200_000n * 10n ** 6n
    const allocatedArm = 1_200_000n * 10n ** 18n
    const netProceeds = 1_100_000n * 10n ** 6n
    const log = encodeLog('Finalized', [saleSize, allocatedArm, netProceeds, false])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('Finalized')
    expect(result!.args.saleSize).toBe(saleSize)
    expect(result!.args.allocatedArm).toBe(allocatedArm)
    expect(result!.args.netProceeds).toBe(netProceeds)
    expect(result!.args.refundMode).toBe(false)
  })

  it('parses Cancelled event', () => {
    const log = encodeLog('Cancelled', [])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('Cancelled')
    expect(result!.args).toEqual({})
  })

  it('parses Allocated event', () => {
    const participant = '0x' + '55'.repeat(20)
    const armTransferred = 500n * 10n ** 18n
    const refundUsdc = 100n * 10n ** 6n
    const delegate = '0x' + '66'.repeat(20)
    const log = encodeLog('Allocated', [participant, armTransferred, refundUsdc, delegate])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('Allocated')
    expect(result!.args.participant).toBe(participant.toLowerCase())
    expect(result!.args.armTransferred).toBe(armTransferred)
    expect(result!.args.refundUsdc).toBe(refundUsdc)
    expect(result!.args.delegate).toBe(delegate.toLowerCase())
  })

  it('parses AllocatedHop event', () => {
    const participant = '0x' + '77'.repeat(20)
    const acceptedUsdc = 3_000n * 10n ** 6n
    const log = encodeLog('AllocatedHop', [participant, 1, acceptedUsdc])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('AllocatedHop')
    expect(result!.args.participant).toBe(participant.toLowerCase())
    expect(result!.args.hop).toBe(1n)
    expect(result!.args.acceptedUsdc).toBe(acceptedUsdc)
  })

  it('parses RefundClaimed event', () => {
    const participant = '0x' + '88'.repeat(20)
    const usdcAmount = 1_000n * 10n ** 6n
    const log = encodeLog('RefundClaimed', [participant, usdcAmount])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('RefundClaimed')
    expect(result!.args.participant).toBe(participant.toLowerCase())
    expect(result!.args.usdcAmount).toBe(usdcAmount)
  })

  it('parses InviteNonceRevoked event', () => {
    const inviter = '0x' + '99'.repeat(20)
    const log = encodeLog('InviteNonceRevoked', [inviter, 7n])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('InviteNonceRevoked')
    expect(result!.args.inviter).toBe(inviter.toLowerCase())
    expect(result!.args.nonce).toBe(7n)
  })

  it('parses UnallocatedArmWithdrawn event', () => {
    const treasury = '0x' + 'aa'.repeat(20)
    const amount = 100_000n * 10n ** 18n
    const log = encodeLog('UnallocatedArmWithdrawn', [treasury, amount])
    const result = parseCrowdfundEvent(log)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('UnallocatedArmWithdrawn')
    expect(result!.args.treasury).toBe(treasury.toLowerCase())
    expect(result!.args.amount).toBe(amount)
  })

  it('returns null for unrecognized log topics', () => {
    const result = parseCrowdfundEvent({
      blockNumber: 100,
      transactionHash: '0x' + 'ff'.repeat(32),
      logIndex: 0,
      topics: ['0x' + 'de'.repeat(32)],
      data: '0x',
    })
    expect(result).toBeNull()
  })

  it('preserves block number and transaction hash', () => {
    const log = encodeLog('ArmLoaded', [], {
      blockNumber: 42,
      transactionHash: '0x' + 'cd'.repeat(32),
    })
    const result = parseCrowdfundEvent(log)
    expect(result!.blockNumber).toBe(42)
    expect(result!.transactionHash).toBe('0x' + 'cd'.repeat(32))
  })

  it('preserves logIndex', () => {
    const log = encodeLog('ArmLoaded', [], { logIndex: 5 })
    const result = parseCrowdfundEvent(log)
    expect(result!.logIndex).toBe(5)
  })
})

describe('parseCrowdfundEvents', () => {
  it('parses multiple logs and filters out unrecognized', () => {
    const logs = [
      encodeLog('ArmLoaded', [], { blockNumber: 1 }),
      { blockNumber: 2, transactionHash: '0x00', logIndex: 0, topics: ['0xdead'], data: '0x' },
      encodeLog('SeedAdded', ['0x' + '11'.repeat(20)], { blockNumber: 3 }),
    ]
    const results = parseCrowdfundEvents(logs)
    expect(results).toHaveLength(2)
    expect(results[0].type).toBe('ArmLoaded')
    expect(results[1].type).toBe('SeedAdded')
  })

  it('returns empty array for empty input', () => {
    expect(parseCrowdfundEvents([])).toEqual([])
  })
})
