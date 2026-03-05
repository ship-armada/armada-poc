// ABOUTME: Treasury panel showing balances, claims, steward budget, and claim exercise.
// ABOUTME: Displays treasury-held ARM/USDC, active claims, and steward budget status.

import { useState } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'
import { isSepoliaMode } from '../config'

interface TreasuryPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

export function TreasuryPanel({ contracts, wallet, govData }: TreasuryPanelProps) {
  const [exerciseClaimId, setExerciseClaimId] = useState('')
  const [exerciseAmount, setExerciseAmount] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

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

  const handleExerciseClaim = async () => {
    if (!wallet.account || !contracts.deployment || !exerciseClaimId || !exerciseAmount) return
    setTxStatus('Exercising claim...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const treasury = new ethers.Contract(
        contracts.deployment.contracts.treasury,
        ['function exerciseClaim(uint256 claimId, uint256 amount)'],
        signer,
      )
      // Determine decimals from claim token (check if it matches ARM or USDC)
      const claim = govData.claims.find((c) => c.id === Number(exerciseClaimId))
      const decimals = claim?.token.toLowerCase() === contracts.deployment.contracts.armToken.toLowerCase() ? 18 : 6
      const amount = ethers.parseUnits(exerciseAmount, decimals)
      const tx = await treasury.exerciseClaim(Number(exerciseClaimId), amount)
      setTxStatus('Confirming...')
      await tx.wait()
      setTxStatus('Claim exercised!')
      setExerciseClaimId('')
      setExerciseAmount('')
      await govData.refresh()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to exercise claim')
      setTxStatus(null)
    }
  }

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
          <StatCard label="Steward" value={truncAddr(govData.treasurySteward)} />
        </div>
      </div>

      {/* Fund Treasury (local mode only) */}
      {!isSepoliaMode() && contracts.deployment && (
        <FundTreasury
          contracts={contracts}
          wallet={wallet}
          onFunded={govData.refresh}
        />
      )}

      {/* Steward Budget */}
      {govData.stewardBudget && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-neutral-300">Steward Monthly Budget (USDC)</h3>
          <div className="grid grid-cols-3 gap-4">
            <StatCard label="Budget" value={fmtUsdc(govData.stewardBudget.budget)} />
            <StatCard label="Spent" value={fmtUsdc(govData.stewardBudget.spent)} />
            <StatCard label="Remaining" value={fmtUsdc(govData.stewardBudget.remaining)} />
          </div>
        </div>
      )}

      {/* Claims */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-neutral-300">
          Claims ({govData.claimCount})
        </h3>
        {govData.claims.length === 0 ? (
          <p className="text-sm text-neutral-500">No claims yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-neutral-500">
                  <th className="pb-2 pr-3">ID</th>
                  <th className="pb-2 pr-3">Token</th>
                  <th className="pb-2 pr-3">Beneficiary</th>
                  <th className="pb-2 pr-3 text-right">Total</th>
                  <th className="pb-2 pr-3 text-right">Exercised</th>
                  <th className="pb-2 text-right">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {govData.claims.map((claim) => {
                  const isArm = contracts.deployment
                    ? claim.token.toLowerCase() === contracts.deployment.contracts.armToken.toLowerCase()
                    : false
                  const fmt = isArm ? fmtArm : fmtUsdc
                  return (
                    <tr key={claim.id} className="border-b border-neutral-900 text-neutral-300">
                      <td className="py-2 pr-3 font-mono">{claim.id}</td>
                      <td className="py-2 pr-3">{isArm ? 'ARM' : 'USDC'}</td>
                      <td className="py-2 pr-3 font-mono">{truncAddr(claim.beneficiary)}</td>
                      <td className="py-2 pr-3 text-right">{fmt(claim.amount)}</td>
                      <td className="py-2 pr-3 text-right">{fmt(claim.exercised)}</td>
                      <td className="py-2 text-right font-medium">{fmt(claim.remaining)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Exercise Claim */}
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">Exercise Claim</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={exerciseClaimId}
            onChange={(e) => setExerciseClaimId(e.target.value)}
            placeholder="Claim ID"
            className="w-24 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <input
            type="text"
            value={exerciseAmount}
            onChange={(e) => setExerciseAmount(e.target.value)}
            placeholder="Amount"
            className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
          />
          <button
            onClick={handleExerciseClaim}
            disabled={!wallet.account || !exerciseClaimId || !exerciseAmount}
            className="rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            Exercise
          </button>
        </div>
        {txStatus && <div className="mt-2 text-xs text-blue-400">{txStatus}</div>}
        {txError && <div className="mt-2 text-xs text-red-400">{txError}</div>}
      </div>
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 font-mono text-sm text-neutral-200">{value}</p>
    </div>
  )
}
