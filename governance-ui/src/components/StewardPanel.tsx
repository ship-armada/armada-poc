// ABOUTME: Steward panel showing current steward status and steward spend proposal form.
// ABOUTME: Steward spending flows through ArmadaGovernor.proposeStewardSpend() as pass-by-default proposals.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'

interface StewardPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

export function StewardPanel({ contracts, wallet, govData }: StewardPanelProps) {
  const [spendRecipient, setSpendRecipient] = useState('')
  const [spendAmount, setSpendAmount] = useState('')
  const [spendDescription, setSpendDescription] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const isSteward = wallet.account?.toLowerCase() === govData.currentSteward.toLowerCase()
  const isZeroAddr = govData.currentSteward === ethers.ZeroAddress

  const formatTimestamp = (ts: bigint) =>
    ts > 0n ? new Date(Number(ts) * 1000).toLocaleString() : 'N/A'

  const handleProposeStewardSpend = async () => {
    if (!contracts.deployment || !wallet.account || !contracts.usdcAddress) return
    if (!spendRecipient || !spendAmount || !spendDescription.trim()) return

    setTxStatus('Creating steward spend proposal...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const gov = new ethers.Contract(
        contracts.deployment.contracts.governor,
        ['function proposeStewardSpend(address[] tokens, address[] recipients, uint256[] amounts, string description) returns (uint256)'],
        signer,
      )
      const amount = ethers.parseUnits(spendAmount, 6)
      const tx = await gov.proposeStewardSpend(
        [contracts.usdcAddress],
        [spendRecipient],
        [amount],
        spendDescription,
      )
      setTxStatus('Waiting for confirmation...')
      await tx.wait()
      setTxStatus('Steward spend proposal created!')
      setSpendRecipient('')
      setSpendAmount('')
      setSpendDescription('')
      await govData.refresh()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to create steward spend proposal')
      setTxStatus(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Steward Status */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Steward Status</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <StatCard
            label="Current Steward"
            value={isZeroAddr ? 'None' : `${govData.currentSteward.slice(0, 10)}...${govData.currentSteward.slice(-6)}`}
          />
          <StatCard
            label="Active"
            value={govData.isStewardActive ? 'Yes' : 'No'}
          />
          <StatCard
            label="Term Ends"
            value={formatTimestamp(govData.termEnd)}
          />
        </div>
        {isSteward && (
          <p className="mt-2 text-xs text-green-400">You are the current steward</p>
        )}
      </div>

      {/* Steward Budget (from treasury) */}
      {govData.stewardBudget && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Steward Budget (USDC)</h3>
          <div className="grid grid-cols-3 gap-4">
            <StatCard
              label="Budget"
              value={Number(ethers.formatUnits(govData.stewardBudget.budget, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            />
            <StatCard
              label="Spent"
              value={Number(ethers.formatUnits(govData.stewardBudget.spent, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            />
            <StatCard
              label="Remaining"
              value={Number(ethers.formatUnits(govData.stewardBudget.remaining, 6)).toLocaleString('en-US', { maximumFractionDigits: 2 })}
            />
          </div>
        </div>
      )}

      {/* Propose Steward Spend (steward only) */}
      {isSteward && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="mb-1 text-sm font-medium text-neutral-300">Propose Steward Spend</h3>
          <p className="mb-3 text-xs text-neutral-500">
            Creates a pass-by-default governance proposal. If not vetoed during the voting period, it executes automatically.
          </p>
          <div className="space-y-2">
            <input
              type="text"
              value={spendRecipient}
              onChange={(e) => setSpendRecipient(e.target.value)}
              placeholder="Recipient address (0x...)"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={spendAmount}
              onChange={(e) => setSpendAmount(e.target.value)}
              placeholder="USDC amount"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={spendDescription}
              onChange={(e) => setSpendDescription(e.target.value)}
              placeholder="Description (required)"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          </div>
          <button
            onClick={handleProposeStewardSpend}
            disabled={!spendRecipient || !spendAmount || !spendDescription.trim()}
            className="mt-2 w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Submit Steward Spend Proposal
          </button>
        </div>
      )}

      {/* Info for non-stewards */}
      {!isSteward && !isZeroAddr && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-sm text-neutral-400">
            Steward spending proposals appear in the Proposals tab as &quot;Steward Spend&quot; type.
            They pass by default unless voted down during the voting period.
          </p>
        </div>
      )}

      {/* TX Status */}
      {txStatus && <div className="text-xs text-blue-400">{txStatus}</div>}
      {txError && <div className="text-xs text-red-400">{txError}</div>}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 font-mono text-sm text-neutral-200">{value}</p>
    </div>
  )
}
