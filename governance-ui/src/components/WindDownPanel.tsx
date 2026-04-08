// ABOUTME: Wind-down status panel showing trigger conditions, sweep actions, and redemption form.
// ABOUTME: Displays wind-down deadline, revenue progress, and post-trigger asset redemption controls.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'

interface WindDownPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

export function WindDownPanel({ contracts, wallet, govData }: WindDownPanelProps) {
  const [redeemAmount, setRedeemAmount] = useState('')
  const [includeUsdc, setIncludeUsdc] = useState(true)
  const [includeEth, setIncludeEth] = useState(false)
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  // If wind-down contract isn't deployed, show a placeholder
  if (!contracts.windDown) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">Wind-Down</h3>
        <p className="mt-2 text-xs text-neutral-500">
          Wind-down contract not deployed in this environment.
        </p>
      </div>
    )
  }

  const fmtUsd = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, 18))
    return '$' + num.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  const fmtArm = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, 18))
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  const deadlineDate = govData.windDownDeadline > 0n
    ? new Date(Number(govData.windDownDeadline) * 1000)
    : null
  const deadlinePassed = govData.blockTimestamp > 0n && govData.windDownDeadline > 0n &&
    govData.blockTimestamp > govData.windDownDeadline
  const revenueBelowThreshold = govData.revenueThreshold > 0n &&
    govData.recognizedRevenue < govData.revenueThreshold
  const canTrigger = !govData.windDownTriggered && deadlinePassed && revenueBelowThreshold

  const revenuePct = govData.revenueThreshold > 0n
    ? Math.min(100, Number((govData.recognizedRevenue * 10000n) / govData.revenueThreshold) / 100)
    : 0

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

  const handleTrigger = () => {
    if (!contracts.deployment) return
    sendTx('Triggering wind-down', async (signer) => {
      const wd = new ethers.Contract(
        contracts.deployment!.contracts.windDown!,
        ['function triggerWindDown()'],
        signer,
      )
      return wd.triggerWindDown()
    })
  }

  const handleSweepToken = (tokenAddr: string, tokenName: string) => {
    if (!contracts.deployment) return
    sendTx(`Sweeping ${tokenName}`, async (signer) => {
      const wd = new ethers.Contract(
        contracts.deployment!.contracts.windDown!,
        ['function sweepToken(address token)'],
        signer,
      )
      return wd.sweepToken(tokenAddr)
    })
  }

  const handleSweepEth = () => {
    if (!contracts.deployment) return
    sendTx('Sweeping ETH', async (signer) => {
      const wd = new ethers.Contract(
        contracts.deployment!.contracts.windDown!,
        ['function sweepETH()'],
        signer,
      )
      return wd.sweepETH()
    })
  }

  const handleRedeem = () => {
    if (!contracts.deployment || !contracts.deployment.contracts.redemption) return
    const tokens: string[] = []
    if (includeUsdc && contracts.usdcAddress) {
      tokens.push(contracts.usdcAddress)
    }
    // Tokens must be sorted ascending for the contract
    tokens.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

    sendTx('Redeeming ARM', async (signer) => {
      const redemption = new ethers.Contract(
        contracts.deployment!.contracts.redemption!,
        ['function redeem(uint256 armAmount, address[] tokens, bool includeETH)'],
        signer,
      )
      const amount = ethers.parseUnits(redeemAmount, 18)
      return redemption.redeem(amount, tokens, includeEth)
    })
  }

  return (
    <div className="space-y-4">
      {/* Status Banner */}
      <div className={`rounded border px-4 py-3 ${
        govData.windDownTriggered
          ? 'border-red-800 bg-red-950/30'
          : 'border-neutral-800 bg-neutral-900'
      }`}>
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${
            govData.windDownTriggered ? 'bg-red-500' : 'bg-green-500'
          }`} />
          <h3 className="text-sm font-medium text-neutral-300">
            Wind-Down: {govData.windDownTriggered ? 'TRIGGERED' : 'Inactive'}
          </h3>
          {govData.windDownActive && (
            <span className="rounded bg-red-900 px-2 py-0.5 text-xs text-red-300">
              Governance Disabled
            </span>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Deadline"
          value={deadlineDate ? deadlineDate.toLocaleDateString() : 'N/A'}
        />
        <StatCard
          label="Deadline Passed"
          value={deadlinePassed ? 'Yes' : 'No'}
        />
        <StatCard
          label="Revenue Threshold"
          value={fmtUsd(govData.revenueThreshold)}
        />
        <StatCard
          label="Recognized Revenue"
          value={fmtUsd(govData.recognizedRevenue)}
        />
      </div>

      {/* Revenue Progress Bar */}
      {govData.revenueThreshold > 0n && (
        <div>
          <div className="flex justify-between text-xs text-neutral-500">
            <span>Revenue vs Threshold</span>
            <span>{revenuePct.toFixed(1)}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded bg-neutral-800">
            <div
              className={`h-full ${revenuePct >= 100 ? 'bg-green-600' : 'bg-yellow-600'}`}
              style={{ width: `${Math.min(revenuePct, 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {revenuePct >= 100
              ? 'Revenue threshold met — wind-down cannot be triggered by deadline alone.'
              : 'Below threshold — wind-down can trigger after deadline passes.'}
          </p>
        </div>
      )}

      {/* Trigger Button (pre-trigger) */}
      {!govData.windDownTriggered && wallet.account && (
        <button
          onClick={handleTrigger}
          disabled={!canTrigger}
          className="w-full rounded bg-red-800 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-700 disabled:opacity-50"
        >
          {canTrigger ? 'Trigger Wind-Down' : 'Conditions Not Met'}
        </button>
      )}

      {/* Post-Trigger: Sweep & Redeem */}
      {govData.windDownTriggered && (
        <>
          {/* Sweep Actions */}
          <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
            <h4 className="mb-2 text-sm font-medium text-neutral-300">Sweep Treasury to Redemption</h4>
            <p className="mb-3 text-xs text-neutral-500">
              Transfer treasury assets to the redemption contract for pro-rata distribution.
            </p>
            <div className="flex flex-wrap gap-2">
              {contracts.usdcAddress && (
                <button
                  onClick={() => handleSweepToken(contracts.usdcAddress!, 'USDC')}
                  className="rounded bg-blue-800 px-3 py-1.5 text-xs text-blue-200 hover:bg-blue-700"
                >
                  Sweep USDC
                </button>
              )}
              <button
                onClick={handleSweepEth}
                className="rounded bg-blue-800 px-3 py-1.5 text-xs text-blue-200 hover:bg-blue-700"
              >
                Sweep ETH
              </button>
            </div>
          </div>

          {/* Redemption */}
          {contracts.deployment?.contracts.redemption && (
            <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
              <h4 className="mb-1 text-sm font-medium text-neutral-300">Redeem ARM</h4>
              <p className="mb-1 text-xs text-neutral-500">
                Burn ARM tokens to receive pro-rata share of swept treasury assets.
              </p>
              {govData.circulatingSupply > 0n && (
                <p className="mb-3 text-xs text-neutral-500">
                  Circulating supply: {fmtArm(govData.circulatingSupply)} ARM
                </p>
              )}
              <div className="space-y-2">
                <input
                  type="text"
                  value={redeemAmount}
                  onChange={(e) => setRedeemAmount(e.target.value)}
                  placeholder="ARM amount to redeem"
                  className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
                />
                <div className="flex items-center gap-4 text-xs text-neutral-400">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={includeUsdc}
                      onChange={(e) => setIncludeUsdc(e.target.checked)}
                      className="rounded"
                    />
                    Include USDC
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={includeEth}
                      onChange={(e) => setIncludeEth(e.target.checked)}
                      className="rounded"
                    />
                    Include ETH
                  </label>
                </div>
                <button
                  onClick={handleRedeem}
                  disabled={!redeemAmount || !wallet.account}
                  className="w-full rounded bg-red-800 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-700 disabled:opacity-50"
                >
                  Redeem
                </button>
              </div>
            </div>
          )}
        </>
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
