// ABOUTME: Form for creating governance proposals with calldata template builders.
// ABOUTME: Supports Standard (distribute), Extended (steward election), and manual calldata types.

import { useState } from 'react'
import { ethers } from 'ethers'
import { ProposalType, PROPOSAL_TYPE_LABELS } from '../governance-types'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'

interface CreateProposalFormProps {
  contracts: GovernanceContracts
  wallet: WalletState
  onCreated: () => Promise<void>
}

export function CreateProposalForm({ contracts, wallet, onCreated }: CreateProposalFormProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [proposalType, setProposalType] = useState<ProposalType>(ProposalType.Standard)
  const [description, setDescription] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  // Treasury template fields
  const [treasuryToken, setTreasuryToken] = useState<'arm' | 'usdc'>('usdc')
  const [treasuryRecipient, setTreasuryRecipient] = useState('')
  const [treasuryAmount, setTreasuryAmount] = useState('')

  // Extended (steward election) template fields
  const [stewardAddress, setStewardAddress] = useState('')

  // Manual calldata fields (for VetoRatification or advanced use)
  const [manualTarget, setManualTarget] = useState('')
  const [manualCalldata, setManualCalldata] = useState('')
  const [manualValue, setManualValue] = useState('0')

  const deployment = contracts.deployment

  const buildActions = (): { targets: string[]; values: bigint[]; calldatas: string[] } | null => {
    if (!deployment) return null

    if (proposalType === ProposalType.Standard) {
      const tokenAddr = treasuryToken === 'arm'
        ? deployment.contracts.armToken
        : contracts.usdcAddress ?? ''
      if (!tokenAddr || !treasuryRecipient || !treasuryAmount) return null

      const decimals = treasuryToken === 'arm' ? 18 : 6
      const amount = ethers.parseUnits(treasuryAmount, decimals)
      const iface = new ethers.Interface([
        'function distribute(address token, address recipient, uint256 amount)',
      ])

      const calldata = iface.encodeFunctionData('distribute', [tokenAddr, treasuryRecipient, amount])

      return {
        targets: [deployment.contracts.treasury],
        values: [0n],
        calldatas: [calldata],
      }
    }

    if (proposalType === ProposalType.Extended) {
      if (!stewardAddress) return null

      const stewardIface = new ethers.Interface([
        'function electSteward(address _steward)',
      ])

      // Elect the person as steward on the TreasurySteward contract.
      // Steward spending is authorized separately via steward budget configuration
      // on the treasury, and spending proposals flow through ArmadaGovernor.proposeStewardSpend().
      return {
        targets: [deployment.contracts.steward],
        values: [0n],
        calldatas: [
          stewardIface.encodeFunctionData('electSteward', [stewardAddress]),
        ],
      }
    }

    // Fallback manual calldata path
    if (!manualTarget || !manualCalldata) return null
    return {
      targets: [manualTarget],
      values: [ethers.parseEther(manualValue || '0')],
      calldatas: [manualCalldata],
    }
  }

  const handleSubmit = async () => {
    if (!wallet.account || !deployment) return
    const actions = buildActions()
    if (!actions) {
      setTxError('Fill in all required fields')
      return
    }
    if (!description.trim()) {
      setTxError('Description is required')
      return
    }

    setTxStatus('Creating proposal...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const gov = new ethers.Contract(
        deployment.contracts.governor,
        ['function propose(uint8 proposalType, address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)'],
        signer,
      )
      const tx = await gov.propose(
        proposalType,
        actions.targets,
        actions.values,
        actions.calldatas,
        description,
      )
      setTxStatus('Waiting for confirmation...')
      await tx.wait()
      setTxStatus('Proposal created!')
      setDescription('')
      setTreasuryRecipient('')
      setTreasuryAmount('')
      setStewardAddress('')
      setManualTarget('')
      setManualCalldata('')
      setManualValue('0')
      await onCreated()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to create proposal')
      setTxStatus(null)
    }
  }

  const actions = buildActions()

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
      >
        + Create Proposal
      </button>
    )
  }

  return (
    <div className="rounded border border-neutral-700 bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-200">Create Proposal</h3>
        <button
          onClick={() => setIsOpen(false)}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Close
        </button>
      </div>

      {/* Proposal Type */}
      <div className="mt-3">
        <label className="text-xs text-neutral-500">Type</label>
        <div className="mt-1 flex gap-2">
          {[ProposalType.Standard, ProposalType.Extended].map((t) => (
            <button
              key={t}
              onClick={() => setProposalType(t)}
              className={`rounded px-3 py-1 text-xs ${
                proposalType === t
                  ? 'bg-blue-700 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {PROPOSAL_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      <div className="mt-3">
        <label className="text-xs text-neutral-500">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe this proposal..."
          className="mt-1 w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
        />
      </div>

      {/* Standard Template */}
      {proposalType === ProposalType.Standard && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <select
              value={treasuryToken}
              onChange={(e) => setTreasuryToken(e.target.value as 'arm' | 'usdc')}
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-300"
            >
              <option value="usdc">USDC (6 decimals)</option>
              <option value="arm">ARM (18 decimals)</option>
            </select>
          </div>
          <input
            type="text"
            value={treasuryRecipient}
            onChange={(e) => setTreasuryRecipient(e.target.value)}
            placeholder="Recipient address"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <input
            type="text"
            value={treasuryAmount}
            onChange={(e) => setTreasuryAmount(e.target.value)}
            placeholder="Amount (human-readable)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
        </div>
      )}

      {/* Extended Template */}
      {proposalType === ProposalType.Extended && (
        <div className="mt-3">
          <input
            type="text"
            value={stewardAddress}
            onChange={(e) => setStewardAddress(e.target.value)}
            placeholder="New steward address (0x...)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Encodes electSteward(person) on the TreasurySteward contract. Steward spending proposals
            are submitted separately via the governor.
          </p>
        </div>
      )}

      {/* VetoRatification Manual Calldata — not shown in selector, kept for completeness */}
      {proposalType === ProposalType.VetoRatification && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={manualTarget}
            onChange={(e) => setManualTarget(e.target.value)}
            placeholder="Target contract address"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <input
            type="text"
            value={manualCalldata}
            onChange={(e) => setManualCalldata(e.target.value)}
            placeholder="Calldata (0x...)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <input
            type="text"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            placeholder="ETH value (0)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
        </div>
      )}

      {/* Encoded Preview */}
      {actions && (
        <div className="mt-3 rounded bg-neutral-950 p-2">
          <p className="text-xs text-neutral-500">Encoded actions:</p>
          {actions.targets.map((target, i) => (
            <div key={i} className="mt-1 text-xs">
              <span className="text-neutral-400">Target: </span>
              <code className="text-neutral-300">{target}</code>
              <br />
              <span className="text-neutral-400">Calldata: </span>
              <code className="break-all text-neutral-500">{actions.calldatas[i]}</code>
            </div>
          ))}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={!wallet.account || !actions || !description.trim()}
        className="mt-3 w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
      >
        Submit Proposal
      </button>

      {txStatus && <div className="mt-2 text-xs text-blue-400">{txStatus}</div>}
      {txError && <div className="mt-2 text-xs text-red-400">{txError}</div>}
    </div>
  )
}
