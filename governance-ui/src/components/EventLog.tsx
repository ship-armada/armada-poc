// ABOUTME: Event log panel showing recent governance events from contract logs.
// ABOUTME: Queries ProposalCreated, VoteCast, and other governance events for debugging.

import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'

interface EventLogEntry {
  blockNumber: number
  eventName: string
  args: string
  contractName: string
}

interface EventLogProps {
  contracts: GovernanceContracts
}

export function EventLog({ contracts }: EventLogProps) {
  const [events, setEvents] = useState<EventLogEntry[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    const { governor, treasury, steward, votingLocker } = contracts
    if (!governor || !treasury || !steward || !votingLocker) return

    setIsLoading(true)
    setError(null)

    try {
      const allEvents: EventLogEntry[] = []

      // Helper to parse events from a contract
      const parseEvents = async (contract: ethers.Contract, contractName: string) => {
        try {
          const logs = await contract.queryFilter('*' as any, 0, 'latest')
          for (const log of logs) {
            try {
              const parsed = contract.interface.parseLog({
                topics: [...log.topics],
                data: log.data,
              })
              if (parsed) {
                const argParts: string[] = []
                for (let i = 0; i < parsed.fragment.inputs.length; i++) {
                  const input = parsed.fragment.inputs[i]!
                  const val = parsed.args[i]
                  const formatted = typeof val === 'bigint'
                    ? val.toString()
                    : String(val)
                  argParts.push(`${input.name}=${formatted}`)
                }
                allEvents.push({
                  blockNumber: log.blockNumber,
                  eventName: parsed.name,
                  args: argParts.join(', '),
                  contractName,
                })
              }
            } catch {
              // Skip unparseable events
            }
          }
        } catch {
          // Skip contracts that fail to query
        }
      }

      await Promise.all([
        parseEvents(governor, 'Governor'),
        parseEvents(treasury, 'Treasury'),
        parseEvents(steward, 'Steward'),
        parseEvents(votingLocker, 'VotingLocker'),
      ])

      // Sort by block number descending
      allEvents.sort((a, b) => b.blockNumber - a.blockNumber)
      setEvents(allEvents.slice(0, 50))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events')
    } finally {
      setIsLoading(false)
    }
  }, [contracts])

  // Fetch events when panel opens
  useEffect(() => {
    if (isOpen && events.length === 0) {
      fetchEvents()
    }
  }, [isOpen, events.length, fetchEvents])

  return (
    <div className="mt-6 border-t border-neutral-800 pt-4">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="text-sm font-medium text-neutral-400 hover:text-neutral-200"
        >
          Event Log {isOpen ? '[-]' : '[+]'} ({events.length})
        </button>
        {isOpen && (
          <button
            onClick={fetchEvents}
            disabled={isLoading}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        )}
      </div>

      {isOpen && (
        <div className="mt-3 max-h-96 overflow-y-auto">
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
          {events.length === 0 && !isLoading ? (
            <p className="text-xs text-neutral-500">No events found.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-neutral-500">
                  <th className="pb-1 pr-3">Block</th>
                  <th className="pb-1 pr-3">Contract</th>
                  <th className="pb-1 pr-3">Event</th>
                  <th className="pb-1">Args</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i} className="border-b border-neutral-900">
                    <td className="py-1 pr-3 font-mono text-neutral-400">{e.blockNumber}</td>
                    <td className="py-1 pr-3 text-neutral-500">{e.contractName}</td>
                    <td className="py-1 pr-3 font-medium text-neutral-300">{e.eventName}</td>
                    <td className="py-1 break-all text-neutral-500">{e.args}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
