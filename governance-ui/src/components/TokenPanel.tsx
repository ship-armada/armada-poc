// ABOUTME: Token management panel for ARM token delegation and voting power.
// ABOUTME: Handles delegate operations and displays balances.

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
  const [delegateAddress, setDelegateAddress] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

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

  const handleSelfDelegate = () => {
    if (!contracts.deployment || !wallet.account) return
    sendTx('Self-delegating', async (signer) => {
      const token = new ethers.Contract(
        contracts.deployment!.contracts.armToken,
        ['function delegate(address delegatee)'],
        signer,
      )
      return token.delegate(wallet.account!)
    })
  }

  const handleDelegate = () => {
    if (!delegateAddress || !contracts.deployment) return
    sendTx('Delegating', async (signer) => {
      const token = new ethers.Contract(
        contracts.deployment!.contracts.armToken,
        ['function delegate(address delegatee)'],
        signer,
      )
      return token.delegate(delegateAddress)
    })
    setDelegateAddress('')
  }

  const truncAddr = (addr: string) =>
    addr && addr !== ethers.ZeroAddress
      ? `${addr.slice(0, 8)}...${addr.slice(-6)}`
      : 'None'

  return (
    <div className="space-y-6">
      {/* Balances Overview */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="ARM Balance" value={fmtShort(govData.armBalance)} />
        <StatCard label="Voting Power" value={fmtShort(govData.votingPower)} />
        <StatCard label="Delegated To" value={truncAddr(govData.delegatee)} />
        <StatCard label="Proposal Threshold" value={fmtShort(govData.proposalThreshold)} />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="Total ARM Supply" value={fmtShort(govData.totalSupply)} />
        <StatCard label="Eligible Supply" value={fmtShort(govData.eligibleSupply)} />
        <StatCard
          label="Block / Timestamp"
          value={`#${govData.blockNumber} / ${new Date(Number(govData.blockTimestamp) * 1000).toLocaleString()}`}
        />
      </div>

      {/* Actions */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Self-Delegate */}
        <ActionCard title="1. Self-Delegate (Activate Voting Power)">
          <p className="mb-3 text-xs text-neutral-500">
            Self-delegate to activate your ARM tokens as voting power.
          </p>
          <button
            onClick={handleSelfDelegate}
            disabled={!wallet.account}
            className="w-full rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            Self-Delegate
          </button>
        </ActionCard>

        {/* Delegate to Another */}
        <ActionCard title="2. Delegate to Address">
          <div className="flex gap-2">
            <input
              type="text"
              value={delegateAddress}
              onChange={(e) => setDelegateAddress(e.target.value)}
              placeholder="0x... delegatee address"
              className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
            />
          </div>
          <button
            onClick={handleDelegate}
            disabled={!delegateAddress || !wallet.account}
            className="mt-2 w-full rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Delegate
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
