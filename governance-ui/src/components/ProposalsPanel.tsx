// ABOUTME: Proposals panel showing the list of all proposals and the create form.
// ABOUTME: Supports filtering by proposal state and displays proposal count.

import { useState } from 'react'
import { ProposalState, PROPOSAL_STATE_LABELS } from '../governance-types'
import { ProposalCard } from './ProposalCard'
import { CreateProposalForm } from './CreateProposalForm'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'

interface ProposalsPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

const STATE_FILTERS: { label: string; value: ProposalState | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: ProposalState.Active },
  { label: 'Pending', value: ProposalState.Pending },
  { label: 'Succeeded', value: ProposalState.Succeeded },
  { label: 'Queued', value: ProposalState.Queued },
  { label: 'Defeated', value: ProposalState.Defeated },
  { label: 'Executed', value: ProposalState.Executed },
  { label: 'Canceled', value: ProposalState.Canceled },
]

export function ProposalsPanel({ contracts, wallet, govData }: ProposalsPanelProps) {
  const [filter, setFilter] = useState<ProposalState | 'all'>('all')

  const filtered = filter === 'all'
    ? govData.proposals
    : govData.proposals.filter((p) => p.state === filter)

  return (
    <div className="space-y-4">
      {/* Create Proposal */}
      <CreateProposalForm
        contracts={contracts}
        wallet={wallet}
        onCreated={govData.refresh}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-neutral-300">
          Proposals ({govData.proposalCount} total, showing {filtered.length})
        </h2>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-1">
        {STATE_FILTERS.map(({ label, value }) => {
          const count = value === 'all'
            ? govData.proposals.length
            : govData.proposals.filter((p) => p.state === value).length
          return (
            <button
              key={label}
              onClick={() => setFilter(value)}
              className={`rounded px-2 py-1 text-xs ${
                filter === value
                  ? 'bg-blue-700 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {label} ({count})
            </button>
          )
        })}
      </div>

      {/* Proposal List */}
      {govData.isLoading ? (
        <div className="py-8 text-center text-sm text-neutral-500">Loading proposals...</div>
      ) : filtered.length === 0 ? (
        <div className="py-8 text-center text-sm text-neutral-500">
          {govData.proposalCount === 0
            ? 'No proposals yet. Create one above!'
            : `No ${filter !== 'all' ? PROPOSAL_STATE_LABELS[filter as ProposalState].toLowerCase() : ''} proposals.`}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              contracts={contracts}
              wallet={wallet}
              onAction={govData.refresh}
              blockTimestamp={govData.blockTimestamp}
            />
          ))}
        </div>
      )}
    </div>
  )
}
