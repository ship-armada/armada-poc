// ABOUTME: Token management panel for ARM token locking and voting power.
// ABOUTME: Handles approve, lock, unlock operations and displays balances.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'

interface TokenPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

export function TokenPanel({ contracts, wallet, govData }: TokenPanelProps) {
  const [approveAmount, setApproveAmount] = useState('')
  const [lockAmount, setLockAmount] = useState('')
  const [unlockAmount, setUnlockAmount] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const fmt = (val: bigint) => ethers.formatUnits(val, 18)
  const fmtShort = (val: bigint) => {
    const num = Number(ethers.formatUnits(val, 18))
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  const sendTx = async (
    label: string,
    fn: (signer: ethers.Signer) => Promise<ethers.TransactionResponse>,
  ) => {
    if (!wallet.account) {
      setTxError('Connect wallet first')
      return
    }
    setTxStatus(`${label}...`)
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const tx = await fn(signer)
      setTxStatus(`${label} — waiting for confirmation...`)
      await tx.wait()
      setTxStatus(`${label} — confirmed!`)
      await govData.refresh()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transaction failed')
      setTxStatus(null)
    }
  }

  const handleApprove = () => {
    if (!approveAmount || !contracts.deployment) return
    const amount = ethers.parseUnits(approveAmount, 18)
    sendTx('Approving', async (signer) => {
      const token = new ethers.Contract(
        contracts.deployment!.contracts.armToken,
        ['function approve(address spender, uint256 amount) returns (bool)'],
        signer,
      )
      return token.approve(contracts.deployment!.contracts.votingLocker, amount)
    })
    setApproveAmount('')
  }

  const handleLock = () => {
    if (!lockAmount || !contracts.deployment) return
    const amount = ethers.parseUnits(lockAmount, 18)
    sendTx('Locking', async (signer) => {
      const locker = new ethers.Contract(
        contracts.deployment!.contracts.votingLocker,
        ['function lock(uint256 amount)'],
        signer,
      )
      return locker.lock(amount)
    })
    setLockAmount('')
  }

  const handleUnlock = () => {
    if (!unlockAmount || !contracts.deployment) return
    const amount = ethers.parseUnits(unlockAmount, 18)
    sendTx('Unlocking', async (signer) => {
      const locker = new ethers.Contract(
        contracts.deployment!.contracts.votingLocker,
        ['function unlock(uint256 amount)'],
        signer,
      )
      return locker.unlock(amount)
    })
    setUnlockAmount('')
  }

  return (
    <div className="space-y-6">
      {/* Balances Overview */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="ARM Balance" value={fmtShort(govData.armBalance)} />
        <StatCard label="Locked (Voting Power)" value={fmtShort(govData.lockedBalance)} />
        <StatCard label="VotingLocker Allowance" value={fmtShort(govData.armAllowance)} />
        <StatCard label="Proposal Threshold" value={fmtShort(govData.proposalThreshold)} />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Total ARM Supply" value={fmtShort(govData.totalSupply)} />
        <StatCard label="Total Locked" value={fmtShort(govData.totalLocked)} />
        <StatCard
          label="Block / Timestamp"
          value={`#${govData.blockNumber} / ${new Date(Number(govData.blockTimestamp) * 1000).toLocaleString()}`}
        />
      </div>

      {/* Actions */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Approve */}
        <ActionCard title="1. Approve VotingLocker">
          <div className="flex gap-2">
            <input
              type="text"
              value={approveAmount}
              onChange={(e) => setApproveAmount(e.target.value)}
              placeholder="ARM amount"
              className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <button
              onClick={() => setApproveAmount(fmt(govData.armBalance))}
              className="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-600"
            >
              Max
            </button>
          </div>
          <button
            onClick={handleApprove}
            disabled={!approveAmount || !wallet.account}
            className="mt-2 w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Approve
          </button>
        </ActionCard>

        {/* Lock */}
        <ActionCard title="2. Lock ARM">
          <div className="flex gap-2">
            <input
              type="text"
              value={lockAmount}
              onChange={(e) => setLockAmount(e.target.value)}
              placeholder="ARM amount"
              className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <button
              onClick={() => {
                const max = govData.armAllowance < govData.armBalance
                  ? govData.armAllowance
                  : govData.armBalance
                setLockAmount(fmt(max))
              }}
              className="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-600"
            >
              Max
            </button>
          </div>
          <button
            onClick={handleLock}
            disabled={!lockAmount || !wallet.account}
            className="mt-2 w-full rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            Lock
          </button>
        </ActionCard>

        {/* Unlock */}
        <ActionCard title="3. Unlock ARM">
          <div className="flex gap-2">
            <input
              type="text"
              value={unlockAmount}
              onChange={(e) => setUnlockAmount(e.target.value)}
              placeholder="ARM amount"
              className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
            <button
              onClick={() => setUnlockAmount(fmt(govData.lockedBalance))}
              className="rounded bg-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-600"
            >
              Max
            </button>
          </div>
          <button
            onClick={handleUnlock}
            disabled={!unlockAmount || !wallet.account}
            className="mt-2 w-full rounded bg-orange-700 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            Unlock
          </button>
        </ActionCard>
      </div>

      {/* TX Status */}
      {txStatus && (
        <div className="rounded bg-blue-900/30 px-4 py-2 text-sm text-blue-300">{txStatus}</div>
      )}
      {txError && (
        <div className="rounded bg-red-900/30 px-4 py-2 text-sm text-red-300">{txError}</div>
      )}
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

function ActionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
      <h3 className="mb-3 text-sm font-medium text-neutral-300">{title}</h3>
      {children}
    </div>
  )
}
