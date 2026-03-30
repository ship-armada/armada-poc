// ABOUTME: Hook for creating, storing, and revoking EIP-712 invite links.
// ABOUTME: Manages IndexedDB-backed invite link lifecycle with on-chain revocation.

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import { CROWDFUND_ABI_FRAGMENTS } from '@armada/crowdfund-shared'
import {
  type StoredInviteLink,
  getEIP712Domain,
  INVITE_TYPES,
  encodeInviteUrl,
  storeInviteLink,
  getStoredInviteLinks,
  updateInviteLinkStatus,
  getNextNonce,
} from '@/lib/inviteLinks'
import { getHubChainId } from '@/config/network'
import { useTransactionFlow } from '@/hooks/useTransactionFlow'

export interface UseInviteLinksResult {
  links: StoredInviteLink[]
  loading: boolean
  createLink: (fromHop: number, deadlineSeconds?: number) => Promise<string | null>
  revokeLink: (nonce: number) => Promise<boolean>
  revokeTx: ReturnType<typeof useTransactionFlow>
  refreshLinks: () => Promise<void>
}

const FIVE_DAYS = 5 * 24 * 60 * 60

export function useInviteLinks(
  address: string | null,
  signer: Signer | null,
  crowdfundAddress: string | null,
  blockTimestamp: number,
): UseInviteLinksResult {
  const [links, setLinks] = useState<StoredInviteLink[]>([])
  const [loading, setLoading] = useState(true)
  const revokeTx = useTransactionFlow(signer)

  const refreshLinks = useCallback(async () => {
    if (!address) {
      setLinks([])
      setLoading(false)
      return
    }

    try {
      const stored = await getStoredInviteLinks(address.toLowerCase())
      // Update expired status
      const updated = stored.map((link) => {
        if (link.status === 'pending' && link.deadline < blockTimestamp) {
          return { ...link, status: 'expired' as const }
        }
        return link
      })
      setLinks(updated.sort((a, b) => b.createdAt - a.createdAt))
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [address, blockTimestamp])

  useEffect(() => {
    refreshLinks()
  }, [refreshLinks])

  const createLink = useCallback(async (fromHop: number, deadlineSeconds?: number): Promise<string | null> => {
    if (!address || !signer || !crowdfundAddress) return null

    try {
      const chainId = getHubChainId()
      const nonce = await getNextNonce(address.toLowerCase())
      const deadline = blockTimestamp + (deadlineSeconds ?? FIVE_DAYS)

      const domain = getEIP712Domain(chainId, crowdfundAddress)
      const value = { inviter: address, fromHop, nonce, deadline }
      const signature = await signer.signTypedData(domain, INVITE_TYPES, value)

      const linkData: StoredInviteLink = {
        inviter: address.toLowerCase(),
        fromHop,
        nonce,
        deadline,
        signature,
        createdAt: blockTimestamp,
        status: 'pending',
      }

      await storeInviteLink(linkData)
      await refreshLinks()

      return encodeInviteUrl(linkData)
    } catch {
      return null
    }
  }, [address, signer, crowdfundAddress, blockTimestamp, refreshLinks])

  const revokeLink = useCallback(async (nonce: number): Promise<boolean> => {
    if (!crowdfundAddress || !address) return false

    const success = await revokeTx.execute(async (s) => {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, s)
      return crowdfund.revokeInviteNonce(nonce)
    })

    if (success) {
      await updateInviteLinkStatus(address.toLowerCase(), nonce, 'revoked')
      await refreshLinks()
    }

    return success
  }, [crowdfundAddress, address, revokeTx, refreshLinks])

  return { links, loading, createLink, revokeLink, revokeTx, refreshLinks }
}
