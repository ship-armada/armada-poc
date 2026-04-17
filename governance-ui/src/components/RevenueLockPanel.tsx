// ABOUTME: RevenueLock status panel showing unlock milestones, beneficiary state, and release action.
// ABOUTME: Supports multiple cohorts via a selector — primary lock + additional cohorts from manifests.

import { useState, useEffect, useCallback } from 'react'
import { ethers } from 'ethers'
import type { GovernanceContracts } from '../hooks/useGovernanceContracts'
import type { WalletState } from '../hooks/useWallet'
import type { GovernanceData } from '../hooks/useGovernanceData'
import { fetchRevenueLockCohorts, type RevenueLockCohort } from '../config'

const REVENUE_LOCK_ABI = [
  'function allocation(address) view returns (uint256)',
  'function released(address) view returns (uint256)',
  'function releasable(address) view returns (uint256)',
  'function unlockPercentage() view returns (uint256)',
  'function totalAllocation() view returns (uint256)',
  'function beneficiaryCount() view returns (uint256)',
  'function release(address delegatee) external',
]

const MILESTONES = [
  { revenue: 10_000, bps: 1000, label: '$10K → 10%' },
  { revenue: 50_000, bps: 2500, label: '$50K → 25%' },
  { revenue: 100_000, bps: 4000, label: '$100K → 40%' },
  { revenue: 250_000, bps: 6000, label: '$250K → 60%' },
  { revenue: 500_000, bps: 8000, label: '$500K → 80%' },
  { revenue: 1_000_000, bps: 10000, label: '$1M → 100%' },
]

interface RevenueLockPanelProps {
  contracts: GovernanceContracts
  wallet: WalletState
  govData: GovernanceData
}

interface BeneficiaryState {
  allocation: bigint
  released: bigint
  releasable: bigint
}

export function RevenueLockPanel({ contracts, wallet, govData }: RevenueLockPanelProps) {
  const [cohorts, setCohorts] = useState<RevenueLockCohort[]>([])
  const [selectedCohortName, setSelectedCohortName] = useState<string | null>(null)
  const [unlockBps, setUnlockBps] = useState(0n)
  const [totalAllocation, setTotalAllocation] = useState(0n)
  const [beneficiaryCount, setBeneficiaryCount] = useState(0n)
  const [userState, setUserState] = useState<BeneficiaryState | null>(null)
  const [delegatee, setDelegatee] = useState('')
  const [txStatus, setTxStatus] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const deployment = contracts.deployment
  const activeCohort = cohorts.find((c) => c.name === selectedCohortName) ?? null
  const activeAddress = activeCohort?.address ?? null

  // Load cohorts whenever the governance deployment becomes available
  useEffect(() => {
    if (!deployment) return
    let cancelled = false
    fetchRevenueLockCohorts(deployment)
      .then((list) => {
        if (cancelled) return
        setCohorts(list)
        if (list.length > 0 && !selectedCohortName) {
          setSelectedCohortName(list[0].name)
        }
      })
      .catch((err) => console.warn('[RevenueLockPanel] cohort discovery failed:', err))
    return () => {
      cancelled = true
    }
  }, [deployment, selectedCohortName])

  const fetchState = useCallback(async () => {
    if (!contracts.provider || !activeAddress) return

    const rl = new ethers.Contract(activeAddress, REVENUE_LOCK_ABI, contracts.provider)

    try {
      const [unlock, total, count] = await Promise.all([
        rl.unlockPercentage(),
        rl.totalAllocation(),
        rl.beneficiaryCount(),
      ])
      setUnlockBps(unlock)
      setTotalAllocation(total)
      setBeneficiaryCount(count)

      if (wallet.account) {
        const [alloc, released, releasable] = await Promise.all([
          rl.allocation(wallet.account),
          rl.released(wallet.account),
          rl.releasable(wallet.account),
        ])
        setUserState({ allocation: alloc, released, releasable })
      } else {
        setUserState(null)
      }
    } catch (err) {
      console.warn('[RevenueLockPanel] fetch error:', err)
    }
  }, [contracts.provider, activeAddress, wallet.account])

  useEffect(() => {
    // Reset per-cohort state when switching
    setUnlockBps(0n)
    setTotalAllocation(0n)
    setBeneficiaryCount(0n)
    setUserState(null)
    fetchState()
    const id = setInterval(fetchState, 15_000)
    return () => clearInterval(id)
  }, [fetchState])

  const handleRelease = async () => {
    if (!wallet.account || !activeAddress) return
    const target = delegatee.trim() || wallet.account

    setTxStatus('Releasing ARM...')
    setTxError(null)
    try {
      const signer = await wallet.getSigner()
      const rl = new ethers.Contract(activeAddress, REVENUE_LOCK_ABI, signer)
      const tx = await rl.release(target)
      setTxStatus('Waiting for confirmation...')
      await tx.wait()
      setTxStatus('ARM released!')
      await fetchState()
      setTimeout(() => setTxStatus(null), 3000)
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Release failed')
      setTxStatus(null)
    }
  }

  if (cohorts.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">Revenue Lock</h3>
        <p className="mt-2 text-xs text-neutral-500">
          No RevenueLock cohorts found for this network.
        </p>
      </div>
    )
  }

  const fmtArm = (v: bigint) => Number(ethers.formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
  const fmtUsd = (v: bigint) => '$' + Number(ethers.formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })
  const unlockPct = Number(unlockBps) / 100
  const currentRevenue = Number(ethers.formatUnits(govData.recognizedRevenue, 18))

  return (
    <div className="space-y-4">
      {/* Cohort Selector */}
      {cohorts.length > 1 && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
          <label className="text-xs text-neutral-500">Cohort</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {cohorts.map((c) => (
              <button
                key={c.name}
                onClick={() => setSelectedCohortName(c.name)}
                className={`rounded px-3 py-1 text-xs ${
                  selectedCohortName === c.name
                    ? 'bg-blue-700 text-white'
                    : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                }`}
              >
                {c.name}
                {c.isPrimary && <span className="ml-1 opacity-60">(primary)</span>}
              </button>
            ))}
          </div>
          {activeCohort && (
            <p className="mt-2 text-xs text-neutral-500 font-mono">
              {activeCohort.address}
            </p>
          )}
        </div>
      )}

      {/* Revenue & Unlock Status */}
      <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-neutral-300">
            Revenue Lock Status{activeCohort ? ` — ${activeCohort.name}` : ''}
          </h3>
          {cohorts.length === 1 && activeCohort && (
            <span className="text-xs text-neutral-500 font-mono">
              {activeCohort.address.slice(0, 6)}...{activeCohort.address.slice(-4)}
            </span>
          )}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-neutral-500">Recognized Revenue</span>
            <p className="text-lg font-medium text-neutral-200">{fmtUsd(govData.recognizedRevenue)}</p>
          </div>
          <div>
            <span className="text-neutral-500">Unlock Percentage</span>
            <p className="text-lg font-medium text-neutral-200">{unlockPct}%</p>
          </div>
          <div>
            <span className="text-neutral-500">Total Allocation</span>
            <p className="text-neutral-300">{fmtArm(totalAllocation)} ARM</p>
          </div>
          <div>
            <span className="text-neutral-500">Beneficiaries</span>
            <p className="text-neutral-300">{beneficiaryCount.toString()}</p>
          </div>
        </div>

        {/* Milestone Progress */}
        <div className="mt-4">
          <p className="text-xs text-neutral-500 mb-2">Unlock Milestones</p>
          <div className="space-y-1">
            {MILESTONES.map((m) => {
              const reached = currentRevenue >= m.revenue
              return (
                <div key={m.revenue} className="flex items-center gap-2 text-xs">
                  <span className={`inline-block h-2 w-2 rounded-full ${reached ? 'bg-green-500' : 'bg-neutral-700'}`} />
                  <span className={reached ? 'text-neutral-200' : 'text-neutral-500'}>{m.label}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Beneficiary Actions */}
      {wallet.account && userState && userState.allocation > 0n && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="text-sm font-medium text-neutral-300">Your Allocation</h3>

          <div className="mt-3 grid grid-cols-3 gap-4 text-xs">
            <div>
              <span className="text-neutral-500">Total Allocation</span>
              <p className="text-neutral-200">{fmtArm(userState.allocation)} ARM</p>
            </div>
            <div>
              <span className="text-neutral-500">Released</span>
              <p className="text-neutral-200">{fmtArm(userState.released)} ARM</p>
            </div>
            <div>
              <span className="text-neutral-500">Releasable Now</span>
              <p className="text-green-400 font-medium">{fmtArm(userState.releasable)} ARM</p>
            </div>
          </div>

          {userState.releasable > 0n && (
            <div className="mt-3 space-y-2">
              <input
                type="text"
                value={delegatee}
                onChange={(e) => setDelegatee(e.target.value)}
                placeholder="Delegate address (blank = self-delegate)"
                className="w-full rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600"
              />
              <button
                onClick={handleRelease}
                className="w-full rounded bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
              >
                Release {fmtArm(userState.releasable)} ARM
              </button>
            </div>
          )}

          {userState.releasable === 0n && userState.released < userState.allocation && (
            <p className="mt-3 text-xs text-neutral-500">
              No ARM available to release. Waiting for the next revenue milestone.
            </p>
          )}

          {userState.released >= userState.allocation && (
            <p className="mt-3 text-xs text-green-500">
              All ARM has been released.
            </p>
          )}

          {txStatus && <p className="mt-2 text-xs text-blue-400">{txStatus}</p>}
          {txError && <p className="mt-2 text-xs text-red-400 break-all">{txError}</p>}
        </div>
      )}

      {wallet.account && userState && userState.allocation === 0n && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">
            Connected wallet is not a beneficiary of this cohort.
          </p>
        </div>
      )}

      {!wallet.account && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-4">
          <p className="text-xs text-neutral-500">
            Connect a wallet to check beneficiary status and release ARM.
          </p>
        </div>
      )}
    </div>
  )
}
