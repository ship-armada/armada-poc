// ABOUTME: Treasury panel showing balances, outflow limits, steward budget, and wind-down status.
// ABOUTME: Displays treasury-held ARM/USDC, outflow rate-limit config, and wind-down controls.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'
import type { OutflowConfig } from '../governance-types'
import { isSepoliaMode } from '../config'
import { WindDownPanel } from './WindDownPanel'

interface TreasuryPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

export function TreasuryPanel({ contracts, wallet, govData }: TreasuryPanelProps) {

  const fmtArm = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, 18))
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const fmtUsdc = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, 6))
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  const truncAddr = (addr: string) =>
    addr ? `${addr.slice(0, 10)}...${addr.slice(-6)}` : 'None'

  return (
    <div className="space-y-6">
      {/* Treasury Address */}
      {contracts.deployment && (
        <div className="rounded-md bg-neutral-900 px-3 py-2">
          <span className="text-xs text-neutral-500">Treasury Contract: </span>
          <span className="font-mono text-xs text-neutral-300">{contracts.deployment.contracts.treasury}</span>
        </div>
      )}

      {/* Treasury Balances */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Treasury Balances</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="ARM" value={`${fmtArm(govData.treasuryArmBalance)} ARM`} />
          <StatCard label="USDC" value={`${fmtUsdc(govData.treasuryUsdcBalance)} USDC`} />
          <StatCard label="Owner (Timelock)" value={truncAddr(govData.treasuryOwner)} />
        </div>
      </div>

      {/* Outflow Limits */}
      {(govData.outflowConfigArm || govData.outflowConfigUsdc) && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Outflow Rate Limits</h3>
          <div className="space-y-3">
            {govData.outflowConfigArm && (
              <OutflowConfigCard
                token="ARM"
                config={govData.outflowConfigArm}
                balance={govData.treasuryArmBalance}
                decimals={18}
              />
            )}
            {govData.outflowConfigUsdc && (
              <OutflowConfigCard
                token="USDC"
                config={govData.outflowConfigUsdc}
                balance={govData.treasuryUsdcBalance}
                decimals={6}
              />
            )}
          </div>
        </div>
      )}

      {/* Fund Treasury (local mode only) */}
      {!isSepoliaMode() && contracts.deployment && (
        <FundTreasury
          contracts={contracts}
          wallet={wallet}
          onFunded={govData.refresh}
        />
      )}

      {/* Wind-Down Status */}
      <WindDownPanel contracts={contracts} wallet={wallet} govData={govData} />

    </div>
  )
}

/** Local-mode helper to fund the treasury with USDC (via faucet) and ARM (via transfer). */
function FundTreasury({
  contracts,
  wallet,
  onFunded,
}: {
  contracts: GovernanceContracts
  wallet: WalletState
  onFunded: () => Promise<void>
}) {
  const [usdcAmount, setUsdcAmount] = useState('10000')
  const [armAmount, setArmAmount] = useState('1000000')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const treasuryAddress = contracts.deployment?.contracts.treasury
  const faucetAddress = contracts.faucetAddress

  const handleFundUsdc = async () => {
    if (!treasuryAddress || !faucetAddress || !wallet.account) return
    setTxStatus('Minting USDC to treasury via faucet...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const faucet = new ethers.Contract(
        faucetAddress,
        ['function dripTo(address recipient)'],
        signer,
      )
      // Each drip gives 1000 USDC. Call multiple times to reach desired amount.
      const targetAmount = Number(usdcAmount)
      const dripsNeeded = Math.ceil(targetAmount / 1000)
      for (let i = 0; i < dripsNeeded; i++) {
        setTxStatus(`Dripping USDC to treasury (${i + 1}/${dripsNeeded})...`)
        const tx = await faucet.dripTo(treasuryAddress)
        await tx.wait()
      }
      setTxStatus(`Funded treasury with ~${dripsNeeded * 1000} USDC!`)
      await onFunded()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to fund USDC')
      setTxStatus(null)
    }
  }

  const handleFundArm = async () => {
    if (!treasuryAddress || !contracts.deployment || !wallet.account) return
    setTxStatus('Transferring ARM to treasury...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const armToken = new ethers.Contract(
        contracts.deployment.contracts.armToken,
        ['function transfer(address to, uint256 amount) returns (bool)'],
        signer,
      )
      const amount = ethers.parseUnits(armAmount, 18)
      const tx = await armToken.transfer(treasuryAddress, amount)
      await tx.wait()
      setTxStatus(`Transferred ${armAmount} ARM to treasury!`)
      await onFunded()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to transfer ARM')
      setTxStatus(null)
    }
  }

  return (
    <div className="rounded border border-dashed border-yellow-800 bg-yellow-950/20 p-4">
      <h3 className="mb-1 text-sm font-medium text-yellow-400">Fund Treasury (Local Mode)</h3>
      <p className="mb-3 text-xs text-neutral-500">
        Send tokens to the treasury for testing. USDC is minted via the Faucet (1000 per drip). ARM is transferred from your account.
      </p>
      <div className="flex flex-wrap gap-3">
        {/* USDC via Faucet */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={usdcAmount}
            onChange={(e) => setUsdcAmount(e.target.value)}
            className="w-28 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200"
          />
          <button
            onClick={handleFundUsdc}
            disabled={!wallet.account || !faucetAddress}
            className="rounded bg-yellow-700 px-3 py-2 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
          >
            Fund USDC
          </button>
        </div>
        {/* ARM via transfer */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={armAmount}
            onChange={(e) => setArmAmount(e.target.value)}
            className="w-28 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200"
          />
          <button
            onClick={handleFundArm}
            disabled={!wallet.account}
            className="rounded bg-yellow-700 px-3 py-2 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
          >
            Fund ARM
          </button>
        </div>
      </div>
      {txStatus && <div className="mt-2 text-xs text-blue-400">{txStatus}</div>}
      {txError && <div className="mt-2 text-xs text-red-400">{txError}</div>}
    </div>
  )
}

function OutflowConfigCard({
  token,
  config,
  balance,
  decimals,
}: {
  token: string
  config: OutflowConfig
  balance: bigint
  decimals: number
}) {
  const fmt = (v: bigint) => {
    const num = Number(ethers.formatUnits(v, decimals))
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const windowDays = Number(config.windowDuration) / 86400

  // Effective limit: max(max(balance * bps / 10000, limitAbsolute), floorAbsolute)
  const pctLimit = (balance * config.limitBps) / 10000n
  const rawLimit = pctLimit > config.limitAbsolute ? pctLimit : config.limitAbsolute
  const effectiveLimit = rawLimit > config.floorAbsolute ? rawLimit : config.floorAbsolute

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
      <p className="mb-2 text-xs font-medium text-neutral-300">{token} Outflow Limits</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
        <div>
          <span className="text-neutral-500">Window: </span>
          <span className="text-neutral-300">{windowDays}d</span>
        </div>
        <div>
          <span className="text-neutral-500">BPS Limit: </span>
          <span className="text-neutral-300">{Number(config.limitBps)} bps ({(Number(config.limitBps) / 100).toFixed(1)}%)</span>
        </div>
        <div>
          <span className="text-neutral-500">Absolute Limit: </span>
          <span className="text-neutral-300">{fmt(config.limitAbsolute)}</span>
        </div>
        <div>
          <span className="text-neutral-500">Floor: </span>
          <span className="text-neutral-300">{fmt(config.floorAbsolute)}</span>
        </div>
        <div className="col-span-2 md:col-span-1">
          <span className="text-neutral-500">Effective Limit: </span>
          <span className="font-medium text-neutral-200">{fmt(effectiveLimit)}</span>
        </div>
      </div>
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
