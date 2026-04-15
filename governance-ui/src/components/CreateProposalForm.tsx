// ABOUTME: Form for creating governance proposals with calldata template builders.
// ABOUTME: Supports treasury, steward, ARM transfers, steward budget, security council, gov params, and manual calldata.

import { useState } from 'react'
import { ethers } from 'ethers'
import { ProposalType } from '../governance-types'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'

/** UI template type — determines which form fields and calldata encoding to use */
type TemplateType = 'treasury' | 'steward' | 'enableTransfers' | 'stewardBudget' | 'securityCouncil' | 'govParams' | 'manual'

const TEMPLATE_LABELS: Record<TemplateType, string> = {
  treasury: 'Treasury Distribution',
  steward: 'Steward Election',
  enableTransfers: 'Enable ARM Transfers',
  stewardBudget: 'Steward Budget Token',
  securityCouncil: 'Set Security Council',
  govParams: 'Update Gov Parameters',
  manual: 'Manual Calldata',
}

/** Maps UI template to on-chain ProposalType */
function templateToProposalType(template: TemplateType): ProposalType {
  if (template === 'steward') return ProposalType.Extended
  if (template === 'manual') return ProposalType.VetoRatification
  return ProposalType.Standard
}

interface CreateProposalFormProps {
  contracts: GovernanceContracts
  wallet: WalletState
  onCreated: () => Promise<void>
}

export function CreateProposalForm({ contracts, wallet, onCreated }: CreateProposalFormProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [template, setTemplate] = useState<TemplateType>('treasury')
  const [description, setDescription] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  // Treasury template fields
  const [treasuryToken, setTreasuryToken] = useState<'arm' | 'usdc'>('usdc')
  const [treasuryRecipient, setTreasuryRecipient] = useState('')
  const [treasuryAmount, setTreasuryAmount] = useState('')

  // Extended (steward election) template fields
  const [stewardAddress, setStewardAddress] = useState('')

  // Steward budget template fields
  const [budgetToken, setBudgetToken] = useState<'usdc' | 'arm'>('usdc')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [budgetWindow, setBudgetWindow] = useState('7')

  // Security council template fields
  const [scAddress, setScAddress] = useState('')

  // Governance parameter template fields
  const [govParamType, setGovParamType] = useState<'standard' | 'extended'>('standard')
  const [govVotingDelay, setGovVotingDelay] = useState('')
  const [govVotingPeriod, setGovVotingPeriod] = useState('')
  const [govExecutionDelay, setGovExecutionDelay] = useState('')
  const [govQuorumBps, setGovQuorumBps] = useState('')

  // Manual calldata fields (for VetoRatification or advanced use)
  const [manualTarget, setManualTarget] = useState('')
  const [manualCalldata, setManualCalldata] = useState('')
  const [manualValue, setManualValue] = useState('0')

  const deployment = contracts.deployment

  const proposalType = templateToProposalType(template)

  const buildActions = (): { targets: string[]; values: bigint[]; calldatas: string[] } | null => {
    if (!deployment) return null

    if (template === 'treasury') {
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

    if (template === 'steward') {
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

    if (template === 'enableTransfers') {
      const iface = new ethers.Interface([
        'function setTransferable(bool _transferable)',
      ])

      return {
        targets: [deployment.contracts.armToken],
        values: [0n],
        calldatas: [iface.encodeFunctionData('setTransferable', [true])],
      }
    }

    if (template === 'stewardBudget') {
      const tokenAddr = budgetToken === 'arm'
        ? deployment.contracts.armToken
        : contracts.usdcAddress ?? ''
      if (!tokenAddr || !budgetLimit) return null

      const decimals = budgetToken === 'arm' ? 18 : 6
      const limit = ethers.parseUnits(budgetLimit, decimals)
      const windowSeconds = BigInt(Math.floor(Number(budgetWindow) * 86400))
      const iface = new ethers.Interface([
        'function addStewardBudgetToken(address token, uint256 limit, uint256 window)',
      ])

      return {
        targets: [deployment.contracts.treasury],
        values: [0n],
        calldatas: [iface.encodeFunctionData('addStewardBudgetToken', [tokenAddr, limit, windowSeconds])],
      }
    }

    if (template === 'securityCouncil') {
      if (!scAddress) return null

      const iface = new ethers.Interface([
        'function setSecurityCouncil(address newSC)',
      ])

      return {
        targets: [deployment.contracts.governor],
        values: [0n],
        calldatas: [iface.encodeFunctionData('setSecurityCouncil', [scAddress])],
      }
    }

    if (template === 'govParams') {
      if (!govVotingDelay || !govVotingPeriod || !govExecutionDelay || !govQuorumBps) return null

      const iface = new ethers.Interface([
        'function setProposalTypeParams(uint8 proposalType, (uint256 votingDelay, uint256 votingPeriod, uint256 executionDelay, uint256 quorumBps) params)',
      ])
      const typeValue = govParamType === 'extended' ? 1 : 0

      return {
        targets: [deployment.contracts.governor],
        values: [0n],
        calldatas: [iface.encodeFunctionData('setProposalTypeParams', [
          typeValue,
          {
            votingDelay: BigInt(Number(govVotingDelay) * 60),
            votingPeriod: BigInt(Number(govVotingPeriod) * 60),
            executionDelay: BigInt(Number(govExecutionDelay) * 60),
            quorumBps: BigInt(govQuorumBps),
          },
        ])],
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
      setBudgetLimit('')
      setBudgetWindow('7')
      setScAddress('')
      setGovVotingDelay('')
      setGovVotingPeriod('')
      setGovExecutionDelay('')
      setGovQuorumBps('')
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

      {/* Template Type */}
      <div className="mt-3">
        <label className="text-xs text-neutral-500">Type</label>
        <div className="mt-1 flex flex-wrap gap-2">
          {(['treasury', 'steward', 'enableTransfers', 'stewardBudget', 'securityCouncil', 'govParams'] as TemplateType[]).map((t) => (
            <button
              key={t}
              onClick={() => setTemplate(t)}
              className={`rounded px-3 py-1 text-xs ${
                template === t
                  ? 'bg-blue-700 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
              }`}
            >
              {TEMPLATE_LABELS[t]}
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

      {/* Treasury Distribution Template */}
      {template === 'treasury' && (
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

      {/* Steward Election Template */}
      {template === 'steward' && (
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

      {/* Enable ARM Transfers Template */}
      {template === 'enableTransfers' && (
        <div className="mt-3 rounded bg-neutral-800 p-3">
          <p className="text-sm text-neutral-300">
            This proposal calls <code className="text-blue-400">setTransferable(true)</code> on the ARM token,
            enabling unrestricted transfers for all holders.
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            This is a one-way action — transfers cannot be re-restricted once enabled.
            Executed by the governance timelock.
          </p>
        </div>
      )}

      {/* Steward Budget Token Template */}
      {template === 'stewardBudget' && (
        <div className="mt-3 space-y-2">
          <select
            value={budgetToken}
            onChange={(e) => setBudgetToken(e.target.value as 'usdc' | 'arm')}
            className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-300"
          >
            <option value="usdc">USDC (6 decimals)</option>
            <option value="arm">ARM (18 decimals)</option>
          </select>
          <input
            type="text"
            value={budgetLimit}
            onChange={(e) => setBudgetLimit(e.target.value)}
            placeholder="Spending limit per window (human-readable)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <input
            type="text"
            value={budgetWindow}
            onChange={(e) => setBudgetWindow(e.target.value)}
            placeholder="Window duration in days"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <p className="text-xs text-neutral-500">
            Authorizes the steward to spend up to the limit per rolling window.
            Calls <code className="text-blue-400">addStewardBudgetToken</code> on the treasury.
          </p>
        </div>
      )}

      {/* Set Security Council Template */}
      {template === 'securityCouncil' && (
        <div className="mt-3">
          <input
            type="text"
            value={scAddress}
            onChange={(e) => setScAddress(e.target.value)}
            placeholder="Security council address (0x...)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Sets the security council on the governor. The SC can veto queued proposals.
            Use <code className="text-blue-400">0x0...0</code> to eject.
          </p>
        </div>
      )}

      {/* Update Governance Parameters Template */}
      {template === 'govParams' && (
        <div className="mt-3 space-y-2">
          <select
            value={govParamType}
            onChange={(e) => setGovParamType(e.target.value as 'standard' | 'extended')}
            className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-300"
          >
            <option value="standard">Standard Proposals</option>
            <option value="extended">Extended Proposals</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={govVotingDelay}
              onChange={(e) => setGovVotingDelay(e.target.value)}
              placeholder="Voting delay (minutes)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={govVotingPeriod}
              onChange={(e) => setGovVotingPeriod(e.target.value)}
              placeholder="Voting period (minutes)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={govExecutionDelay}
              onChange={(e) => setGovExecutionDelay(e.target.value)}
              placeholder="Execution delay (minutes)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={govQuorumBps}
              onChange={(e) => setGovQuorumBps(e.target.value)}
              placeholder="Quorum (bps, e.g. 2000=20%)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          </div>
          <p className="text-xs text-neutral-500">
            Updates timing and quorum for Standard or Extended proposals.
            VetoRatification and Steward params are immutable.
          </p>
        </div>
      )}

      {/* Manual Calldata — not shown in selector, kept for completeness */}
      {template === 'manual' && (
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
