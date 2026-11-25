// ABOUTME: React Query wrapper around readRefundOnlyClaim: the connected wallet's first-sale (Sale 1) refund.
// ABOUTME: Owns its own hub read provider so it works in pre-launch builds, which have no app-level provider.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonRpcProvider } from 'ethers'
import { createProvider } from '@armada/crowdfund-shared'
import { getHubRpcUrls } from '@/config/network'
import { getRefundOnlyCrowdfundAddress } from '@/config/refundOnly'
import {
  readRefundOnlyClaim,
  refundOnlyContract,
  type RefundOnlyClaimState,
  type RefundOnlyReader,
} from '@/lib/refundOnlyClaim'

export interface UseRefundOnlyClaimResult {
  /** The first-sale crowdfund, or null when this network has none (feature off). */
  crowdfundAddress: string | null
  /** Hub read provider for the claim's confirmation race; null when the feature is off. */
  provider: JsonRpcProvider | null
  /** Null while loading, without a wallet, or with the feature off. */
  state: RefundOnlyClaimState | null
  loading: boolean
  refetch: () => Promise<unknown>
}

export function useRefundOnlyClaim(wallet: string | null): UseRefundOnlyClaimResult {
  const crowdfundAddress = useMemo(() => getRefundOnlyCrowdfundAddress(), [])
  const provider = useMemo(
    () => (crowdfundAddress ? createProvider(getHubRpcUrls()) : null),
    [crowdfundAddress],
  )
  const enabled = !!crowdfundAddress && !!provider && !!wallet
  // Keyed by wallet, so an account switch starts a fresh (loading) read and no previous
  // wallet's state leaks.
  const query = useQuery({
    queryKey: ['refundOnlyClaim', crowdfundAddress, wallet?.toLowerCase()],
    enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      readRefundOnlyClaim(
        refundOnlyContract(crowdfundAddress!, provider!) as unknown as RefundOnlyReader,
        wallet!,
      ),
  })
  return {
    crowdfundAddress,
    provider,
    state: enabled ? (query.data ?? null) : null,
    loading: enabled && query.isPending,
    refetch: query.refetch,
  }
}
