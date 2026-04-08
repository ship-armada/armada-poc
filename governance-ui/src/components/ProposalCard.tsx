// ABOUTME: Displays a single governance proposal with state, votes, quorum, and action buttons.
// ABOUTME: Supports voting, queuing, executing, and canceling proposals based on current state.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { ProposalData } from '../governance-types'
import {
  ProposalState,
  ProposalType,
  VoteSupport,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_STATE_LABELS,
  PROPOSAL_STATE_COLORS,
  VOTE_SUPPORT_LABELS,
} from '../governance-types'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'

interface ProposalCardProps {
  proposal: ProposalData
  contracts: GovernanceContracts
  wallet: WalletState
  onAction: () => Promise<void>
  blockTimestamp: bigint
  securityCouncil: string
}

export function ProposalCard({ proposal, contracts, wallet, onAction, blockTimestamp, securityCouncil }: ProposalCardProps) {
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const p = proposal
  const totalVotes = p.forVotes + p.againstVotes + p.abstainVotes
  const quorumVotes = p.forVotes + p.abstainVotes
  const quorumPct = p.quorumRequired > 0n
    ? Number((quorumVotes * 10000n) / p.quorumRequired) / 100
    : 0

  const formatVotes = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, 18))
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
    return num.toFixed(0)
  }

  const votePct = (v: bigint) =>
    totalVotes > 0n ? Number((v * 10000n) / totalVotes) / 100 : 0

  const formatRelativeTime = (timestamp: bigint) => {
    const diff = Number(timestamp) - Number(blockTimestamp)
    if (diff <= 0) return 'passed'
    const days = Math.floor(diff / 86400)
    const hours = Math.floor((diff % 86400) / 3600)
    if (days > 0) return `${days}d ${hours}h`
    const mins = Math.floor((diff % 3600) / 60)
    return `${hours}h ${mins}m`
  }

  const sendTx = async (
    label: string,
    fn: (signer: ethers.Signer) => Promise<ethers.TransactionResponse>,
  ) => {
    if (!wallet.account) return
    setTxStatus(`${label}...`)
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const tx = await fn(signer)
      setTxStatus(`${label} — confirming...`)
      await tx.wait()
      setTxStatus(null)
      await onAction()
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transaction failed')
      setTxStatus(null)
    }
  }

  const handleVote = (support: VoteSupport) => {
    if (!contracts.deployment) return
    sendTx(`Voting ${VOTE_SUPPORT_LABELS[support]}`, async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function castVote(uint256 proposalId, uint8 support)'],
        signer,
      )
      return gov.castVote(p.id, support)
    })
  }

  const handleQueue = () => {
    if (!contracts.deployment) return
    sendTx('Queuing', async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function queue(uint256 proposalId)'],
        signer,
      )
      return gov.queue(p.id)
    })
  }

  const handleExecute = () => {
    if (!contracts.deployment) return
    sendTx('Executing', async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function execute(uint256 proposalId) payable'],
        signer,
      )
      return gov.execute(p.id)
    })
  }

  const handleCancel = () => {
    if (!contracts.deployment) return
    sendTx('Canceling', async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function cancel(uint256 proposalId)'],
        signer,
      )
      return gov.cancel(p.id)
    })
  }

  const handleVeto = () => {
    if (!contracts.deployment) return
    sendTx('Vetoing', async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function veto(uint256 proposalId, bytes32 rationaleHash)'],
        signer,
      )
      return gov.veto(p.id, ethers.ZeroHash)
    })
  }

  const handleResolveRatification = () => {
    if (!contracts.deployment) return
    sendTx('Resolving ratification', async (signer) => {
      const gov = new ethers.Contract(
        contracts.deployment!.contracts.governor,
        ['function resolveRatification(uint256 ratificationId)'],
        signer,
      )
      return gov.resolveRatification(p.id)
    })
  }

  const isVetoRatification = p.proposalType === ProposalType.VetoRatification
  const isSC = wallet.account?.toLowerCase() === securityCouncil.toLowerCase() &&
    securityCouncil !== ethers.ZeroAddress

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-neutral-400">#{p.id}</span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${PROPOSAL_STATE_COLORS[p.state]}`}>
              {PROPOSAL_STATE_LABELS[p.state]}
            </span>
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
              {PROPOSAL_TYPE_LABELS[p.proposalType]}
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-200">
            {p.description || <span className="italic text-neutral-500">No description</span>}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Proposer: {p.proposer.slice(0, 10)}...{p.proposer.slice(-6)}
          </p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          {expanded ? 'Collapse' : 'Details'}
        </button>
      </div>

      {/* Veto Ratification Banner */}
      {isVetoRatification && (
        <div className="mt-2 rounded bg-orange-950/30 border border-orange-900 px-3 py-2 text-xs text-orange-300">
          Veto Ratification: <strong>FOR</strong> = uphold the veto, <strong>AGAINST</strong> = eject Security Council permanently.
          {p.vetoedProposalId && <span> (Vetoed proposal: #{p.vetoedProposalId})</span>}
        </div>
      )}

      {/* Vetoed indicator on canceled proposals */}
      {p.state === ProposalState.Canceled && p.ratificationId && (
        <div className="mt-2 rounded bg-orange-950/30 border border-orange-900 px-3 py-2 text-xs text-orange-300">
          This proposal was vetoed by the Security Council. See ratification vote: #{p.ratificationId}
        </div>
      )}

      {/* Timing */}
      <div className="mt-3 flex gap-4 text-xs text-neutral-500">
        <span>
          Vote start: {p.state === ProposalState.Pending
            ? `in ${formatRelativeTime(p.voteStart)}`
            : new Date(Number(p.voteStart) * 1000).toLocaleString()}
        </span>
        <span>
          Vote end: {p.state === ProposalState.Active
            ? `in ${formatRelativeTime(p.voteEnd)}`
            : new Date(Number(p.voteEnd) * 1000).toLocaleString()}
        </span>
      </div>

      {/* Vote Tally */}
      <div className="mt-3">
        <div className="flex justify-between text-xs text-neutral-400">
          <span>For: {formatVotes(p.forVotes)} ({votePct(p.forVotes).toFixed(1)}%)</span>
          <span>Against: {formatVotes(p.againstVotes)} ({votePct(p.againstVotes).toFixed(1)}%)</span>
          <span>Abstain: {formatVotes(p.abstainVotes)} ({votePct(p.abstainVotes).toFixed(1)}%)</span>
        </div>
        {/* Vote bar */}
        <div className="mt-1 flex h-2 overflow-hidden rounded bg-neutral-800">
          {totalVotes > 0n && (
            <>
              <div
                className="bg-green-600"
                style={{ width: `${votePct(p.forVotes)}%` }}
              />
              <div
                className="bg-red-600"
                style={{ width: `${votePct(p.againstVotes)}%` }}
              />
              <div
                className="bg-neutral-500"
                style={{ width: `${votePct(p.abstainVotes)}%` }}
              />
            </>
          )}
        </div>
      </div>

      {/* Quorum Progress */}
      <div className="mt-2">
        <div className="flex justify-between text-xs text-neutral-500">
          <span>Quorum: {formatVotes(quorumVotes)} / {formatVotes(p.quorumRequired)}</span>
          <span>{Math.min(quorumPct, 100).toFixed(1)}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full ${quorumPct >= 100 ? 'bg-green-600' : 'bg-yellow-600'}`}
            style={{ width: `${Math.min(quorumPct, 100)}%` }}
          />
        </div>
      </div>

      {/* User Vote Status */}
      {p.hasVoted && p.userVoteChoice !== null && (
        <div className="mt-2 text-xs text-neutral-400">
          You voted: <span className="font-medium text-neutral-200">
            {VOTE_SUPPORT_LABELS[p.userVoteChoice as VoteSupport]}
          </span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-3 flex flex-wrap gap-2">
        {p.state === ProposalState.Active && !p.hasVoted && wallet.account && (
          <>
            <button
              onClick={() => handleVote(VoteSupport.For)}
              className="rounded bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
            >
              {isVetoRatification ? 'Uphold Veto (For)' : 'Vote For'}
            </button>
            <button
              onClick={() => handleVote(VoteSupport.Against)}
              className="rounded bg-red-800 px-3 py-1 text-xs text-red-200 hover:bg-red-700"
            >
              {isVetoRatification ? 'Eject SC (Against)' : 'Vote Against'}
            </button>
            <button
              onClick={() => handleVote(VoteSupport.Abstain)}
              className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-600"
            >
              Abstain
            </button>
          </>
        )}
        {p.state === ProposalState.Succeeded && !isVetoRatification && (
          <button
            onClick={handleQueue}
            className="rounded bg-purple-800 px-3 py-1 text-xs text-purple-200 hover:bg-purple-700"
          >
            Queue to Timelock
          </button>
        )}
        {isVetoRatification &&
          (p.state === ProposalState.Succeeded || p.state === ProposalState.Defeated) && (
          <button
            onClick={handleResolveRatification}
            className="rounded bg-orange-800 px-3 py-1 text-xs text-orange-200 hover:bg-orange-700"
          >
            Resolve Ratification
          </button>
        )}
        {p.state === ProposalState.Queued && (
          <>
            <button
              onClick={handleExecute}
              className="rounded bg-emerald-800 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-700"
            >
              Execute
            </button>
            {isSC && (
              <button
                onClick={handleVeto}
                className="rounded bg-orange-800 px-3 py-1 text-xs text-orange-200 hover:bg-orange-700"
              >
                Veto (as SC)
              </button>
            )}
          </>
        )}
        {p.state === ProposalState.Pending &&
          wallet.account?.toLowerCase() === p.proposer.toLowerCase() && (
          <button
            onClick={handleCancel}
            className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-600"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="mt-3 border-t border-neutral-800 pt-3 text-xs">
          <p className="text-neutral-500">Snapshot block: {p.snapshotBlock.toString()}</p>
          <p className="text-neutral-500">
            Eligible supply at snapshot: {formatVotes(p.snapshotEligibleSupply)} ARM
          </p>
          <p className="text-neutral-500">
            Quorum required: {ethers.formatUnits(p.quorumRequired, 18)} ARM
          </p>
        </div>
      )}

      {/* TX Status */}
      {txStatus && (
        <div className="mt-2 text-xs text-blue-400">{txStatus}</div>
      )}
      {txError && (
        <div className="mt-2 text-xs text-red-400">{txError}</div>
      )}
    </div>
  )
}
