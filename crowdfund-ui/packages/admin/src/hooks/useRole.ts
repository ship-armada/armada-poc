// ABOUTME: Detects the connected wallet's admin role by reading contract addresses.
// ABOUTME: Compares connected address against launchTeam(), securityCouncil(), treasury().

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { JsonRpcProvider } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'

export type AdminRole = 'launch_team' | 'security_council' | 'observer'

export interface UseRoleResult {
  role: AdminRole
  launchTeamAddress: string | null
  securityCouncilAddress: string | null
  treasuryAddress: string | null
  loading: boolean
}

export function useRole(
  provider: JsonRpcProvider | null,
  contractAddress: string | null,
  connectedAddress: string | null,
): UseRoleResult {
  const [launchTeamAddress, setLaunchTeamAddress] = useState<string | null>(null)
  const [securityCouncilAddress, setSecurityCouncilAddress] = useState<string | null>(null)
  const [treasuryAddress, setTreasuryAddress] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchRoles = useCallback(async () => {
    if (!provider || !contractAddress) {
      setLoading(false)
      return
    }

    try {
      const contract = new Contract(contractAddress, CROWDFUND_ABI_FRAGMENTS, provider)
      const [lt, sc, treasury] = await Promise.all([
        contract.launchTeam() as Promise<string>,
        contract.securityCouncil() as Promise<string>,
        contract.treasury() as Promise<string>,
      ])
      setLaunchTeamAddress(lt.toLowerCase())
      setSecurityCouncilAddress(sc.toLowerCase())
      setTreasuryAddress(treasury.toLowerCase())
    } catch {
      // Non-fatal — role detection fails gracefully to observer
    } finally {
      setLoading(false)
    }
  }, [provider, contractAddress])

  useEffect(() => {
    fetchRoles()
  }, [fetchRoles])

  const addr = connectedAddress?.toLowerCase() ?? null
  let role: AdminRole = 'observer'
  if (addr && addr === launchTeamAddress) role = 'launch_team'
  else if (addr && addr === securityCouncilAddress) role = 'security_council'

  return { role, launchTeamAddress, securityCouncilAddress, treasuryAddress, loading }
}
