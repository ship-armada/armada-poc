// ABOUTME: Hook for creating, storing, and revoking EIP-712 invite links.
// ABOUTME: Manages IndexedDB-backed invite link lifecycle with on-chain revocation.

import { useState, useEffect, useCallback, useMemo } from 'react'
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
  pickInviteNonce,
  effectiveTimestamp,
  classifyStoredLinks,
} from '@/lib/inviteLinks'
import { getHubChainId, getTxConfirmations } from '@/config/network'
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
  /** Full event stream — lets the hook persist `redeemed` link status from chain
   *  truth (display only; nonce selection reads `usedNonces` directly). */
  events: CrowdfundEvent[] = [],
): UseInviteLinksResult {
  // Raw stored links — read from IndexedDB only on address change (and after an
  // explicit create/revoke via refreshLinks), NOT on every poll tick.
  const [storedLinks, setStoredLinks] = useState<StoredInviteLink[]>([])
  const [loading, setLoading] = useState(true)

  const refreshLinks = useCallback(async () => {
    if (!address) {
      setStoredLinks([])
      setLoading(false)
      return
    }
    try {
      setStoredLinks(await getStoredInviteLinks(address.toLowerCase()))
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [address])

  useEffect(() => {
    refreshLinks()
  }, [refreshLinks])

  const lowerAddr = address ? address.toLowerCase() : null

  // Redeemed nonces from chain truth, content-stable so a fresh `events` array
  // identity each poll doesn't churn downstream when the set is unchanged.
  const redeemedSig = useMemo(() => {
    if (!lowerAddr) return ''
    const ns: number[] = []
    for (const e of events) {
      if (e.type === 'Invited' && String(e.args.inviter).toLowerCase() === lowerAddr) {
        const n = Number(e.args.nonce)
        if (n > 0) ns.push(n)
      }
    }
    return ns.sort((a, b) => a - b).join(',')
  }, [events, lowerAddr])

  const redeemedNonces = useMemo<Set<number>>(
    () => new Set(redeemedSig ? redeemedSig.split(',').map(Number) : []),
    [redeemedSig],
  )

  // Signature of which pending links have crossed their deadline — drives
  // re-classification only when expiry actually changes, not every timestamp tick.
  const expirySig = useMemo(
    () =>
      storedLinks
        .filter((l) => l.status === 'pending' && l.deadline < blockTimestamp)
        .map((l) => l.nonce)
        .join(','),
    [storedLinks, blockTimestamp],
  )

  // Classify expiry/redeemed at render time. `blockTimestamp` is intentionally
  // not a dep — `expirySig` captures the only blockTimestamp-driven change.
  const links = useMemo(
    () =>
      classifyStoredLinks(storedLinks, redeemedNonces, blockTimestamp).sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedLinks, redeemedNonces, expirySig],
  )

  // Persist newly-redeemed links to IDB so they survive a cold load where the
  // event stream isn't available yet. Display already reflects redeemedNonces.
  useEffect(() => {
    if (!lowerAddr) return
    for (const l of storedLinks) {
      if (redeemedNonces.has(l.nonce) && l.status !== 'redeemed' && l.status !== 'revoked') {
        void updateInviteLinkStatus(lowerAddr, l.nonce, 'redeemed').catch(() => {})
      }
    }
  }, [storedLinks, redeemedNonces, lowerAddr])

  const createLink = useCallback(async (fromHop: number, deadlineSeconds?: number): Promise<string | null> => {
    if (!address || !signer || !crowdfundAddress) return null

    try {
      const chainId = getHubChainId()
      // Pick a random nonce and confirm it is unused on-chain. Random (not
      // sequential) avoids colliding with a pending link minted on another
      // device — pending links leave no on-chain trace for a "max + 1" scheme to
      // see, so only a large random space sidesteps the clash without on-chain
      // coordination. `usedNonces` is authoritative for redeemed + revoked.
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
      const nonce = await pickInviteNonce(
        (n) => crowdfund.usedNonces(address, n) as Promise<boolean>,
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
        toast.error('Could not create invite link', { description: mapRevertToMessage(err), duration: 10_000 })
      }
      return null
    }
  }, [address, signer, crowdfundAddress, blockTimestamp, refreshLinks])

  const revokeLink = useCallback(async (nonce: number): Promise<boolean> => {
    if (!crowdfundAddress || !address || !signer) return false

    try {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
      const tx = await crowdfund.revokeInviteNonce(nonce)
      const receipt = await tx.wait(getTxConfirmations(), TX_WAIT_TIMEOUT_MS)
      if (!receipt || receipt.status === 0) return false
      await updateInviteLinkStatus(address.toLowerCase(), nonce, 'revoked')
      await refreshLinks()
      return true
    } catch (err) {
      // Quiet on a user-rejected tx; surface real failures.
      if (!isUserRejection(err)) {
        toast.error('Could not revoke invite', { description: mapRevertToMessage(err), duration: 10_000 })
      }
      return false
    }
  }, [crowdfundAddress, address, signer, refreshLinks])

  return { links, loading, createLink, revokeLink, refreshLinks }
}
