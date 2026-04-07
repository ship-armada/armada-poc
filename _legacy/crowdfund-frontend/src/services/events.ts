// ABOUTME: Event listener setup for ArmadaCrowdfund contract events.
// ABOUTME: Provides historical event fetching and live event streaming.
import type { Contract } from 'ethers'
import type { CrowdfundEvent } from '@/types/crowdfund'

/** Extract named args from a parsed log, converting bigint values to strings */
export function parseEventArgs(
  parsed: { fragment: { inputs: ReadonlyArray<{ name: string }> }; args: Record<string, unknown> },
): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const input of parsed.fragment.inputs) {
    const value = parsed.args[input.name]
    args[input.name] = typeof value === 'bigint' ? value.toString() : value
  }
  return args
}

const EVENT_NAMES = [
  'SeedAdded',
  'InvitationStarted',
  'Invited',
  'InviteAdded',
  'Committed',
  'Finalized',
  'Cancelled',
  'Allocated',
  'RefundClaimed',
  'ProceedsWithdrawn',
  'UnallocatedArmWithdrawn',
] as const

/** Fetch past events from a given block number to latest */
export async function fetchPastEvents(
  contract: Contract,
  fromBlock: number = 0,
): Promise<CrowdfundEvent[]> {
  const events: CrowdfundEvent[] = []

  for (const name of EVENT_NAMES) {
    try {
      const filter = contract.filters[name]?.()
      if (!filter) continue

      const logs = await contract.queryFilter(filter, fromBlock)
      for (const log of logs) {
        const parsed = contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        })
        if (!parsed) continue

        events.push({
          name: parsed.name,
          args: parseEventArgs(parsed),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        })
      }
    } catch {
      // Skip events that fail to query (e.g., contract not yet deployed)
    }
  }

  // Sort by block number ascending
  events.sort((a, b) => a.blockNumber - b.blockNumber)
  return events
}

/** Subscribe to live contract events, calling the callback for each new event */
export function subscribeToEvents(
  contract: Contract,
  callback: (event: CrowdfundEvent) => void,
): () => void {
  const listeners: Array<{ name: string; listener: (...args: unknown[]) => void }> = []

  for (const name of EVENT_NAMES) {
    const listener = (...args: unknown[]) => {
      // In ethers v6, the last argument is a ContractEventPayload
      const payload = args[args.length - 1] as any
      const log = payload?.log
      if (!log) return

      const parsed = contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      })
      if (!parsed) return

      callback({
        name: parsed.name,
        args: parseEventArgs(parsed),
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      })
    }

    contract.on(name, listener)
    listeners.push({ name, listener })
  }

  // Return unsubscribe function
  return () => {
    for (const { name, listener } of listeners) {
      contract.off(name, listener)
    }
  }
}
