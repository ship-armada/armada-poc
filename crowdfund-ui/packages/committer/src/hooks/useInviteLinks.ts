// ABOUTME: Hook for creating, storing, and revoking EIP-712 invite links.
// ABOUTME: Manages IndexedDB-backed invite link lifecycle with on-chain revocation.

import { useState, useEffect, useCallback } from 'react'
import { Contract } from 'ethers'
import type { Signer } from 'ethers'
import { toast } from 'sonner'
import { CROWDFUND_ABI_FRAGMENTS, type CrowdfundEvent } from '@armada/crowdfund-shared'
import {
  type StoredInviteLink,
  getEIP712Domain,
  INVITE_TYPES,
  encodeInviteUrl,
  storeInviteLink,
  getStoredInviteLinks,
  updateInviteLinkStatus,
  getNextNonce,
  inviterOnChainNonces,
  effectiveTimestamp,
  classifyStoredLinks,
} from '@/lib/inviteLinks'
import { getHubChainId } from '@/config/network'
import { TX_WAIT_TIMEOUT_MS, isUserRejection } from '@/lib/txWait'
import { mapRevertToMessage } from '@/lib/revertMessages'

export interface UseInviteLinksResult {
  links: StoredInviteLink[]
  loading: boolean
  createLink: (fromHop: number, deadlineSeconds?: number) => Promise<string | null>
  revokeLink: (nonce: number) => Promise<boolean>
  refreshLinks: () => Promise<void>
}

const FIVE_DAYS = 5 * 24 * 60 * 60

export function useInviteLinks(
  address: string | null,
  signer: Signer | null,
  crowdfundAddress: string | null,
  blockTimestamp: number,
  /** Full event stream — lets the hook persist `redeemed` from chain truth and
   *  seed nonces past any already-consumed on-chain nonce. */
  events: CrowdfundEvent[] = [],
): UseInviteLinksResult {
  const [links, setLinks] = useState<StoredInviteLink[]>([])
  const [loading, setLoading] = useState(true)

  const refreshLinks = useCallback(async () => {
    if (!address) {
      setLinks([])
      setLoading(false)
      return
    }

    try {
      const lowerAddr = address.toLowerCase()
      const stored = await getStoredInviteLinks(lowerAddr)
      // Nonces this inviter has had redeemed on-chain (Invited with nonce > 0).
      const redeemedNonces = new Set<number>()
      for (const e of events) {
        if (e.type !== 'Invited') continue
        if (String(e.args.inviter).toLowerCase() !== lowerAddr) continue
        const n = Number(e.args.nonce)
        if (n > 0) redeemedNonces.add(n)
      }

      const updated = classifyStoredLinks(stored, redeemedNonces, blockTimestamp)
      // Persist newly-redeemed links so they survive past their deadline
      // (a redeemed slot must never revert to "available").
      for (let i = 0; i < stored.length; i += 1) {
        if (stored[i].status !== 'redeemed' && updated[i].status === 'redeemed') {
          await updateInviteLinkStatus(lowerAddr, stored[i].nonce, 'redeemed').catch(() => {})
        }
      }
      setLinks(updated.sort((a, b) => b.createdAt - a.createdAt))
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [address, blockTimestamp, events])

  useEffect(() => {
    refreshLinks()
  }, [refreshLinks])

  const createLink = useCallback(async (fromHop: number, deadlineSeconds?: number): Promise<string | null> => {
    if (!address || !signer || !crowdfundAddress) return null

    try {
      const chainId = getHubChainId()
      // Seed the nonce from chain truth so a fresh device / cleared storage
      // doesn't re-sign a nonce already consumed on-chain.
      const nonce = await getNextNonce(
        address.toLowerCase(),
        inviterOnChainNonces(events, address),
      )
      // Never sign a 1970-relative deadline before block time hydrates.
      const baseTs = effectiveTimestamp(blockTimestamp)
      const deadline = baseTs + (deadlineSeconds ?? FIVE_DAYS)

      const domain = getEIP712Domain(chainId, crowdfundAddress)
      const value = { inviter: address, fromHop, nonce, deadline }
      const signature = await signer.signTypedData(domain, INVITE_TYPES, value)

      const linkData: StoredInviteLink = {
        inviter: address.toLowerCase(),
        fromHop,
        nonce,
        deadline,
        signature,
        createdAt: baseTs,
        status: 'pending',
      }

      await storeInviteLink(linkData)
      await refreshLinks()

      return encodeInviteUrl(linkData)
    } catch (err) {
      // Quiet on a user-rejected signature; surface real failures.
      if (!isUserRejection(err)) {
        toast.error('Could not create invite link', { description: mapRevertToMessage(err) })
      }
      return null
    }
  }, [address, signer, crowdfundAddress, blockTimestamp, events, refreshLinks])

  const revokeLink = useCallback(async (nonce: number): Promise<boolean> => {
    if (!crowdfundAddress || !address || !signer) return false

    try {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
      const tx = await crowdfund.revokeInviteNonce(nonce)
      const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS)
      if (!receipt || receipt.status === 0) return false
      await updateInviteLinkStatus(address.toLowerCase(), nonce, 'revoked')
      await refreshLinks()
      return true
    } catch (err) {
      // Quiet on a user-rejected tx; surface real failures.
      if (!isUserRejection(err)) {
        toast.error('Could not revoke invite', { description: mapRevertToMessage(err) })
      }
      return false
    }
  }, [crowdfundAddress, address, signer, refreshLinks])

  return { links, loading, createLink, revokeLink, refreshLinks }
}
