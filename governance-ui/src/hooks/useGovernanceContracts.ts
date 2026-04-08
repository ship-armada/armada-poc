// ABOUTME: Fetches governance deployment manifests and creates ethers.Contract instances.
// ABOUTME: Provides read-only contracts (via JsonRpcProvider) for all governance components.

import { useState, useEffect } from 'react'
import { ethers } from 'ethers'
import {
  fetchGovernanceDeployment,
  fetchUsdcAddress,
  fetchFaucetAddress,
  getHubRpcUrl,
  isSepoliaMode,
  type GovernanceDeployment,
} from '../config'
import {
  ARM_TOKEN_ABI,
  ERC20_VOTES_ABI,
  GOVERNOR_ABI,
  TREASURY_ABI,
  STEWARD_ABI,
  ERC20_ABI,
  WIND_DOWN_ABI,
  REDEMPTION_ABI,
  REVENUE_COUNTER_ABI,
} from '../governance-abis'

export interface GovernanceContracts {
  /** Read-only provider for the hub chain */
  provider: ethers.JsonRpcProvider | null
  /** Contract instances (read-only, use signer for writes) */
  armToken: ethers.Contract | null
  governor: ethers.Contract | null
  treasury: ethers.Contract | null
  steward: ethers.Contract | null
  /** USDC contract for treasury balance queries */
  usdc: ethers.Contract | null
  /** Wind-down, redemption, and revenue counter contracts (optional — may not be deployed) */
  windDown: ethers.Contract | null
  redemption: ethers.Contract | null
  revenueCounter: ethers.Contract | null
  /** Raw deployment data */
  deployment: GovernanceDeployment | null
  /** USDC token address */
  usdcAddress: string | null
  /** Faucet address (local mode only — mints USDC) */
  faucetAddress: string | null
  /** Loading / error state */
  isLoading: boolean
  error: string | null
}

export function useGovernanceContracts(): GovernanceContracts {
  const [state, setState] = useState<GovernanceContracts>({
    provider: null,
    armToken: null,
    governor: null,
    treasury: null,
    steward: null,
    usdc: null,
    windDown: null,
    redemption: null,
    revenueCounter: null,
    deployment: null,
    usdcAddress: null,
    faucetAddress: null,
    isLoading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [deployment, usdcAddress, faucetAddress] = await Promise.all([
          fetchGovernanceDeployment(),
          fetchUsdcAddress().catch(() => ''),
          isSepoliaMode() ? Promise.resolve('') : fetchFaucetAddress().catch(() => ''),
        ])

        if (cancelled) return

        const provider = new ethers.JsonRpcProvider(getHubRpcUrl())
        const { contracts } = deployment

        setState({
          provider,
          armToken: new ethers.Contract(contracts.armToken, [...ARM_TOKEN_ABI, ...ERC20_VOTES_ABI], provider),
          governor: new ethers.Contract(contracts.governor, GOVERNOR_ABI, provider),
          treasury: new ethers.Contract(contracts.treasury, TREASURY_ABI, provider),
          steward: new ethers.Contract(contracts.steward, STEWARD_ABI, provider),
          usdc: usdcAddress
            ? new ethers.Contract(usdcAddress, ERC20_ABI, provider)
            : null,
          windDown: contracts.windDown
            ? new ethers.Contract(contracts.windDown, WIND_DOWN_ABI, provider)
            : null,
          redemption: contracts.redemption
            ? new ethers.Contract(contracts.redemption, REDEMPTION_ABI, provider)
            : null,
          revenueCounter: contracts.revenueCounter
            ? new ethers.Contract(contracts.revenueCounter, REVENUE_COUNTER_ABI, provider)
            : null,
          deployment,
          usdcAddress,
          faucetAddress: faucetAddress || null,
          isLoading: false,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load deployment',
        }))
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return state
}
