// ABOUTME: Steward panel showing current steward status, action queue, and action management.
// ABOUTME: Allows stewards to propose and execute actions, and shows veto/execution status.

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
  const [actionTarget, setActionTarget] = useState('')
  const [actionCalldata, setActionCalldata] = useState('')
  const [actionValue, setActionValue] = useState('0')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  // Steward spend template
  const [spendRecipient, setSpendRecipient] = useState('')
  const [spendAmount, setSpendAmount] = useState('')
  const [useSpendTemplate, setUseSpendTemplate] = useState(true)

  const isSteward = wallet.account?.toLowerCase() === govData.currentSteward.toLowerCase()
  const isZeroAddr = govData.currentSteward === ethers.ZeroAddress

  const formatTimestamp = (ts: bigint) =>
    ts > 0n ? new Date(Number(ts) * 1000).toLocaleString() : 'N/A'

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
      setTxStatus(`${label} — done!`)
      await govData.refresh()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transaction failed')
      setTxStatus(null)
    }
  }

  const handleProposeAction = () => {
    if (!contracts.deployment) return

    let target: string
    let data: string
    let value: bigint

    if (useSpendTemplate) {
      if (!spendRecipient || !spendAmount || !contracts.usdcAddress) return
      // Encode stewardSpend on the treasury
      target = contracts.deployment.contracts.treasury
      const iface = new ethers.Interface([
        'function stewardSpend(address token, address recipient, uint256 amount)',
      ])
      data = iface.encodeFunctionData('stewardSpend', [
        contracts.usdcAddress,
        spendRecipient,
        ethers.parseUnits(spendAmount, 6),
      ])
      value = 0n
    } else {
      if (!actionTarget || !actionCalldata) return
      target = actionTarget
      data = actionCalldata
      value = ethers.parseEther(actionValue || '0')
    }

    sendTx('Proposing action', async (signer) => {
      const steward = new ethers.Contract(
        contracts.deployment!.contracts.steward,
        ['function proposeAction(address target, bytes data, uint256 value) returns (uint256)'],
        signer,
      )
      return steward.proposeAction(target, data, value)
    })
  }

  const handleExecuteAction = (actionId: number) => {
    if (!contracts.deployment) return
    sendTx(`Executing action #${actionId}`, async (signer) => {
      const steward = new ethers.Contract(
        contracts.deployment!.contracts.steward,
        ['function executeAction(uint256 actionId)'],
        signer,
      )
      return steward.executeAction(actionId)
    })
  }

  return (
    <div className="space-y-6">
      {/* Steward Status */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Steward Status</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
          <StatCard
            label="Action Delay"
            value={`${Number(govData.actionDelay)} seconds`}
          />
        </div>
        {isSteward && (
          <p className="mt-2 text-xs text-green-400">You are the current steward</p>
        )}
      </div>

      {/* Propose Action (steward only) */}
      {isSteward && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Propose Action</h3>
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => setUseSpendTemplate(true)}
              className={`rounded px-3 py-1 text-xs ${useSpendTemplate ? 'bg-blue-700 text-white' : 'bg-neutral-800 text-neutral-400'}`}
            >
              Spend USDC
            </button>
            <button
              onClick={() => setUseSpendTemplate(false)}
              className={`rounded px-3 py-1 text-xs ${!useSpendTemplate ? 'bg-blue-700 text-white' : 'bg-neutral-800 text-neutral-400'}`}
            >
              Custom
            </button>
          </div>

          {useSpendTemplate ? (
            <div className="space-y-2">
              <input
                type="text"
                value={spendRecipient}
                onChange={(e) => setSpendRecipient(e.target.value)}
                placeholder="Recipient address"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
              <input
                type="text"
                value={spendAmount}
                onChange={(e) => setSpendAmount(e.target.value)}
                placeholder="USDC amount"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                value={actionTarget}
                onChange={(e) => setActionTarget(e.target.value)}
                placeholder="Target address"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
              <input
                type="text"
                value={actionCalldata}
                onChange={(e) => setActionCalldata(e.target.value)}
                placeholder="Calldata (0x...)"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
              <input
                type="text"
                value={actionValue}
                onChange={(e) => setActionValue(e.target.value)}
                placeholder="ETH value"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
            </div>
          )}

          <button
            onClick={handleProposeAction}
            className="mt-2 w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Propose Action
          </button>
        </div>
      )}

      {/* Action Queue */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">
          Action Queue ({govData.stewardActionCount})
        </h3>
        {govData.stewardActions.length === 0 ? (
          <p className="text-sm text-neutral-500">No steward actions yet.</p>
        ) : (
          <div className="space-y-2">
            {govData.stewardActions.map((action) => {
              const canExecute = isSteward &&
                !action.executed &&
                !action.vetoed &&
                govData.blockTimestamp >= action.executeAfter
              const isPending = !action.executed && !action.vetoed && govData.blockTimestamp < action.executeAfter

              return (
                <div key={action.id} className="rounded border border-neutral-800 bg-neutral-900 p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-neutral-400">#{action.id}</span>
                    {action.executed && (
                      <span className="rounded bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">Executed</span>
                    )}
                    {action.vetoed && (
                      <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-300">Vetoed</span>
                    )}
                    {isPending && (
                      <span className="rounded bg-yellow-900 px-2 py-0.5 text-xs text-yellow-300">Pending</span>
                    )}
                    {canExecute && (
                      <span className="rounded bg-green-900 px-2 py-0.5 text-xs text-green-300">Ready</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    <p>Target: <code className="text-neutral-400">{action.target}</code></p>
                    <p>Value: {ethers.formatEther(action.value)} ETH</p>
                    <p>Execute after: {formatTimestamp(action.executeAfter)}</p>
                  </div>
                  {canExecute && (
                    <button
                      onClick={() => handleExecuteAction(action.id)}
                      className="mt-2 rounded bg-emerald-800 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-700"
                    >
                      Execute
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

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
