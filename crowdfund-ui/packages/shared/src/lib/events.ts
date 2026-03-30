// ABOUTME: Crowdfund event type definitions and parsing utilities.
// ABOUTME: Converts raw ethers log entries into typed CrowdfundEvent objects.

import { Interface } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from './constants.js'

/** All event types emitted by ArmadaCrowdfund */
export type CrowdfundEventType =
  | 'ArmLoaded'
  | 'SeedAdded'
  | 'Invited'
  | 'Committed'
  | 'Finalized'
  | 'Cancelled'
  | 'Allocated'
  | 'AllocatedHop'
  | 'RefundClaimed'
  | 'InviteNonceRevoked'
  | 'UnallocatedArmWithdrawn'

/** Raw log shape from eth_getLogs or ethers provider */
export interface RawLog {
  readonly blockNumber: number
  readonly transactionHash: string
  readonly logIndex: number
  readonly topics: string[]
  readonly data: string
}

/** Parsed crowdfund event with typed fields */
export interface CrowdfundEvent {
  readonly type: CrowdfundEventType
  readonly blockNumber: number
  readonly transactionHash: string
  readonly logIndex: number
  readonly args: Record<string, unknown>
}

const VALID_EVENT_TYPES = new Set<string>([
  'ArmLoaded',
  'SeedAdded',
  'Invited',
  'Committed',
  'Finalized',
  'Cancelled',
  'Allocated',
  'AllocatedHop',
  'RefundClaimed',
  'InviteNonceRevoked',
  'UnallocatedArmWithdrawn',
])

const crowdfundInterface = new Interface(CROWDFUND_ABI_FRAGMENTS)

/**
 * Serialize parsed event args into a plain record.
 * Addresses are lowercased, bigints kept as bigint, numbers/booleans as-is.
 */
function serializeArgs(
  args: Record<string, unknown>,
  inputs: ReadonlyArray<{ name: string }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const input of inputs) {
    const value = args[input.name]
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      result[input.name] = value.toLowerCase()
    } else if (typeof value === 'bigint') {
      result[input.name] = value
    } else if (typeof value === 'number') {
      result[input.name] = value
    } else if (typeof value === 'boolean') {
      result[input.name] = value
    } else {
      result[input.name] = value
    }
  }
  return result
}

/**
 * Parse a raw log into a typed CrowdfundEvent.
 * Returns null for logs that don't match any known crowdfund event.
 */
export function parseCrowdfundEvent(log: RawLog): CrowdfundEvent | null {
  try {
    const parsed = crowdfundInterface.parseLog({
      topics: log.topics,
      data: log.data,
    })
    if (!parsed) return null
    if (!VALID_EVENT_TYPES.has(parsed.name)) return null

    return {
      type: parsed.name as CrowdfundEventType,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      args: serializeArgs(parsed.args, parsed.fragment.inputs),
    }
  } catch {
    return null
  }
}

/** Parse multiple raw logs, filtering out unrecognized events */
export function parseCrowdfundEvents(logs: RawLog[]): CrowdfundEvent[] {
  const events: CrowdfundEvent[] = []
  for (const log of logs) {
    const event = parseCrowdfundEvent(log)
    if (event) events.push(event)
  }
  return events
}
