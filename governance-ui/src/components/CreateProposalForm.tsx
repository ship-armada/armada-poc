// ABOUTME: Form for creating governance proposals with calldata template builders.
// ABOUTME: Supports treasury, steward, ARM transfers, steward budget, security council, gov params, revenue lock cohort, and manual calldata.

import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import { ProposalType } from '../governance-types'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'
import { fetchRevenueLockCohorts, type RevenueLockCohort } from '../config'

/** UI template type — determines which form fields and calldata encoding to use */
type TemplateType = 'treasury' | 'steward' | 'enableTransfers' | 'stewardBudget' | 'outflowConfig' | 'securityCouncil' | 'govParams' | 'attestRevenue' | 'revenueLockCohort' | 'signaling' | 'manual'

const TEMPLATE_LABELS: Record<TemplateType, string> = {
  treasury: 'Treasury Distribution',
  steward: 'Steward Election',
  enableTransfers: 'Enable ARM Transfers',
  stewardBudget: 'Steward Budget Token',
  outflowConfig: 'Init Outflow Limits',
  securityCouncil: 'Set Security Council',
  govParams: 'Update Gov Parameters',
  attestRevenue: 'Attest Revenue',
  revenueLockCohort: 'Register Revenue Lock Cohort',
  signaling: 'Signaling (Non-Binding)',
  manual: 'Manual Calldata',
}

/** Maps UI template to on-chain ProposalType */
function templateToProposalType(template: TemplateType): ProposalType {
  if (template === 'steward') return ProposalType.Extended
  if (template === 'signaling') return ProposalType.Signaling
  if (template === 'manual') return ProposalType.VetoRatification
  return ProposalType.Standard
}

interface CreateProposalFormProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
  onCreated: () => Promise<void>
}

export function CreateProposalForm({ contracts, wallet, govData, onCreated }: CreateProposalFormProps) {
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

  // Outflow config template fields
  const [outflowToken, setOutflowToken] = useState<'usdc' | 'arm'>('usdc')
  const [outflowWindow, setOutflowWindow] = useState('7')
  const [outflowBps, setOutflowBps] = useState('1000')
  const [outflowAbsolute, setOutflowAbsolute] = useState('')
  const [outflowFloor, setOutflowFloor] = useState('')

  // Attest revenue template fields
  const [revenueAmount, setRevenueAmount] = useState('')

  // Revenue lock cohort template fields
  const [cohortList, setCohortList] = useState<RevenueLockCohort[]>([])
  const [cohortSelection, setCohortSelection] = useState<string>('') // manifest name, or 'custom'
  const [cohortAddress, setCohortAddress] = useState('')
  const [cohortFundingAmount, setCohortFundingAmount] = useState('')
  const [cohortIncludeWhitelist, setCohortIncludeWhitelist] = useState(true)
  const [cohortIncludeDelegator, setCohortIncludeDelegator] = useState(true)
  const [cohortIncludeFunding, setCohortIncludeFunding] = useState(true)

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

  // Discover deployed cohort manifests for the cohort registration template
  useEffect(() => {
    if (!deployment) return
    let cancelled = false
    fetchRevenueLockCohorts(deployment)
      .then((list) => {
        if (cancelled) return
        setCohortList(list)
      })
      .catch(() => {
        // Directory listing may be unavailable — the custom address input is still usable
      })
    return () => {
      cancelled = true
    }
  }, [deployment])

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

    if (template === 'outflowConfig') {
      const tokenAddr = outflowToken === 'arm'
        ? deployment.contracts.armToken
        : contracts.usdcAddress ?? ''
      if (!tokenAddr || !outflowAbsolute || !outflowFloor) return null

      const decimals = outflowToken === 'arm' ? 18 : 6
      const windowSeconds = BigInt(Math.floor(Number(outflowWindow) * 86400))
      const iface = new ethers.Interface([
        'function initOutflowConfig(address token, uint256 windowDuration, uint256 limitBps, uint256 limitAbsolute, uint256 floorAbsolute)',
      ])

      return {
        targets: [deployment.contracts.treasury],
        values: [0n],
        calldatas: [iface.encodeFunctionData('initOutflowConfig', [
          tokenAddr,
          windowSeconds,
          BigInt(outflowBps),
          ethers.parseUnits(outflowAbsolute, decimals),
          ethers.parseUnits(outflowFloor, decimals),
        ])],
      }
    }

    if (template === 'attestRevenue') {
      if (!revenueAmount || !deployment.contracts.revenueCounter) return null

      const amountUsd = ethers.parseUnits(revenueAmount, 18)
      const iface = new ethers.Interface([
        'function attestRevenue(uint256 newCumulativeUsd)',
      ])

      return {
        targets: [deployment.contracts.revenueCounter],
        values: [0n],
        calldatas: [iface.encodeFunctionData('attestRevenue', [amountUsd])],
      }
    }

    if (template === 'revenueLockCohort') {
      const lockAddr = cohortSelection && cohortSelection !== 'custom'
        ? cohortList.find((c) => c.name === cohortSelection)?.address ?? ''
        : cohortAddress
      if (!lockAddr || !ethers.isAddress(lockAddr)) return null
      if (!cohortIncludeWhitelist && !cohortIncludeDelegator && !cohortIncludeFunding) return null
      if (cohortIncludeFunding && !cohortFundingAmount) return null

      const tokenIface = new ethers.Interface([
        'function addToWhitelist(address account)',
        'function addAuthorizedDelegator(address delegator)',
      ])
      const treasuryIface = new ethers.Interface([
        'function distribute(address token, address recipient, uint256 amount)',
      ])

      const targets: string[] = []
      const values: bigint[] = []
      const calldatas: string[] = []

      if (cohortIncludeWhitelist) {
        targets.push(deployment.contracts.armToken)
        values.push(0n)
        calldatas.push(tokenIface.encodeFunctionData('addToWhitelist', [lockAddr]))
      }
      if (cohortIncludeDelegator) {
        targets.push(deployment.contracts.armToken)
        values.push(0n)
        calldatas.push(tokenIface.encodeFunctionData('addAuthorizedDelegator', [lockAddr]))
      }
      if (cohortIncludeFunding) {
        const amount = ethers.parseUnits(cohortFundingAmount, 18)
        targets.push(deployment.contracts.treasury)
        values.push(0n)
        calldatas.push(treasuryIface.encodeFunctionData('distribute', [
          deployment.contracts.armToken,
          lockAddr,
          amount,
        ]))
      }

      return { targets, values, calldatas }
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

    if (template === 'signaling') {
      return {
        targets: [],
        values: [],
        calldatas: [],
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
      setOutflowAbsolute('')
      setOutflowFloor('')
      setOutflowBps('1000')
      setOutflowWindow('7')
      setRevenueAmount('')
      setCohortSelection('')
      setCohortAddress('')
      setCohortFundingAmount('')
      setCohortIncludeWhitelist(true)
      setCohortIncludeDelegator(true)
      setCohortIncludeFunding(true)
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
          {(['treasury', 'steward', 'enableTransfers', 'stewardBudget', 'outflowConfig', 'securityCouncil', 'govParams', 'attestRevenue', 'revenueLockCohort', 'signaling'] as TemplateType[]).map((t) => (
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

      {/* Init Outflow Limits Template */}
      {template === 'outflowConfig' && (
        <div className="mt-3 space-y-2">
          <select
            value={outflowToken}
            onChange={(e) => setOutflowToken(e.target.value as 'usdc' | 'arm')}
            className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-300"
          >
            <option value="usdc">USDC (6 decimals)</option>
            <option value="arm">ARM (18 decimals)</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={outflowWindow}
              onChange={(e) => setOutflowWindow(e.target.value)}
              placeholder="Window (days)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={outflowBps}
              onChange={(e) => setOutflowBps(e.target.value)}
              placeholder="Limit % (bps, 1000=10%)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={outflowAbsolute}
              onChange={(e) => setOutflowAbsolute(e.target.value)}
              placeholder="Absolute cap (human-readable)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <input
              type="text"
              value={outflowFloor}
              onChange={(e) => setOutflowFloor(e.target.value)}
              placeholder="Floor minimum (human-readable)"
              className="rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          </div>
          <p className="text-xs text-neutral-500">
            One-time initialization of outflow rate limits for a token. Required before any
            treasury distributions or steward spending. Limit = min(bps% of balance, absolute cap),
            but never below the floor. Floor is immutable after initialization.
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

      {/* Attest Revenue Template */}
      {template === 'attestRevenue' && (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={revenueAmount}
            onChange={(e) => setRevenueAmount(e.target.value)}
            placeholder="Cumulative revenue in USD (e.g. 10000)"
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <p className="text-xs text-neutral-500">
            Sets the cumulative recognized revenue on the RevenueCounter. Must be ≥ current value
            (monotonic). Triggers RevenueLock unlock milestones: $10K→10%, $50K→25%, $100K→40%,
            $250K→60%, $500K→80%, $1M→100%.
          </p>
          {govData.recognizedRevenue > 0n && (
            <p className="text-xs text-neutral-400">
              Current recognized revenue: ${Number(ethers.formatUnits(govData.recognizedRevenue, 18)).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Register Revenue Lock Cohort Template */}
      {template === 'revenueLockCohort' && (
        <div className="mt-3 space-y-2">
          <label className="text-xs text-neutral-500">Cohort</label>
          <select
            value={cohortSelection}
            onChange={(e) => {
              const v = e.target.value
              setCohortSelection(v)
              if (v && v !== 'custom') {
                const match = cohortList.find((c) => c.name === v)
                if (match) setCohortAddress(match.address)
                if (match?.totalAllocation) setCohortFundingAmount(match.totalAllocation)
              } else if (v === 'custom') {
                setCohortAddress('')
                setCohortFundingAmount('')
              }
            }}
            className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-300"
          >
            <option value="">Select a cohort…</option>
            {cohortList
              .filter((c) => !c.isPrimary)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} — {c.address.slice(0, 6)}...{c.address.slice(-4)}
                  {c.totalAllocation ? ` (${c.totalAllocation} ARM)` : ''}
                </option>
              ))}
            <option value="custom">Custom address…</option>
          </select>

          {cohortSelection === 'custom' && (
            <input
              type="text"
              value={cohortAddress}
              onChange={(e) => setCohortAddress(e.target.value)}
              placeholder="RevenueLock contract address (0x...)"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          )}

          <div className="space-y-1 rounded bg-neutral-950 p-2">
            <p className="text-xs text-neutral-400">Include in this batch proposal:</p>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={cohortIncludeWhitelist}
                onChange={(e) => setCohortIncludeWhitelist(e.target.checked)}
              />
              <code className="text-blue-400">armToken.addToWhitelist(lock)</code>
              <span className="text-neutral-500">— allow lock to send ARM on release()</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={cohortIncludeDelegator}
                onChange={(e) => setCohortIncludeDelegator(e.target.checked)}
              />
              <code className="text-blue-400">armToken.addAuthorizedDelegator(lock)</code>
              <span className="text-neutral-500">— allow delegateOnBehalf</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={cohortIncludeFunding}
                onChange={(e) => setCohortIncludeFunding(e.target.checked)}
              />
              <code className="text-blue-400">treasury.distribute(ARM, lock, amount)</code>
              <span className="text-neutral-500">— fund the cohort</span>
            </label>
          </div>

          {cohortIncludeFunding && (
            <input
              type="text"
              value={cohortFundingAmount}
              onChange={(e) => setCohortFundingAmount(e.target.value)}
              placeholder="Funding amount in ARM (e.g. 100)"
              className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          )}

          <p className="text-xs text-neutral-500">
            Registers a new RevenueLock cohort with the token (whitelist + authorized delegator)
            and funds it from the treasury in a single batch. Deploy the cohort first via
            <code className="mx-1 text-neutral-400">npm run deploy:revenue-lock-cohort:sepolia</code>
            then select it here.
          </p>
        </div>
      )}

      {/* Signaling Template */}
      {template === 'signaling' && (
        <div className="mt-3 rounded bg-neutral-800 p-3">
          <p className="text-sm text-neutral-300">
            A non-binding, text-only proposal for gauging community sentiment.
            No on-chain execution — the outcome is purely informational.
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Uses Standard timing and quorum. The description is the entire proposal content.
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
