// ABOUTME: Derives a CrowdfundInviteSlotConfig from the committer's useInviteLinks + eligibility state.
// ABOUTME: Single-source-of-truth adapter consumed by both the inline (MyPosition view) and standalone (Invite Slots page) surfaces.

import { useCallback, useMemo, useState } from 'react'
import { Contract, type JsonRpcProvider, type Signer } from 'ethers'
import { encodeInviteUrl, type StoredInviteLink } from '@/lib/inviteLinks'
import {
  CROWDFUND_ABI_FRAGMENTS,
  type CrowdfundInviteSlotConfig,
  type SlotCardEnsResult,
  type SlotData,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'

export interface UseInviteSlotsResult {
  config: CrowdfundInviteSlotConfig
  hopLabel: string
  totalSlots: number
  /** True when the user has no eligibility positions; both surfaces should hide rather than render zero slots. */
  empty: boolean
}

/**
 * Map a list of stored invite-link records into the designer's SlotData shape,
 * one slot per row. Used (pending or redeemed) links fill slot rows in creation
 * order; remaining rows stay 'empty'. Revoked / expired links free their slot
 * back to empty so the user can regenerate without exceeding the cap.
 *
 * Single-hop only — picks the user's first eligibility position. Multi-hop
 * slot management is deferred (TODO).
 */
export function useInviteSlots(
  position: HopPosition | null,
  inviteLinks: UseInviteLinksResult,
  provider: JsonRpcProvider | null,
  signer: Signer | null,
  crowdfundAddress: string | null,
): UseInviteSlotsResult {
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)

  // HopPosition doesn't carry a `total` field — derive it from used+available.
  const totalSlots = position ? position.invitesUsed + position.invitesAvailable : 0
  const hop = position?.hop ?? 0
  const hopLabel = position ? `Hop ${hop}` : '—'

  // Active link records (pending or redeemed) consume slot rows. Revoked /
  // expired records are dropped so the slot returns to "empty".
  const activeLinks = useMemo<StoredInviteLink[]>(() => {
    return inviteLinks.links
      .filter((l) => l.fromHop === hop)
      .filter((l) => l.status === 'pending' || l.status === 'redeemed')
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [inviteLinks.links, hop])

  // Build the visible slot rows. We assign slot IDs positionally (1..N).
  const slots = useMemo<SlotData[]>(() => {
    const out: SlotData[] = []
    for (let i = 0; i < totalSlots; i += 1) {
      const slotId = i + 1
      const link = activeLinks[i]
      if (!link) {
        out.push({ id: slotId, status: 'empty' })
        continue
      }
      if (link.status === 'redeemed') {
        out.push({ id: slotId, status: 'redeemed' })
        continue
      }
      // pending — render as link-active with the encoded URL + expiry
      out.push({
        id: slotId,
        status: 'link-active',
        link: encodeInviteUrl(link),
        expiresAt: new Date(link.deadline * 1000),
      })
    }
    return out
  }, [totalSlots, activeLinks])

  // Map slotId → matching link record (for revoke nonce lookup).
  const linkBySlotId = useMemo(() => {
    const m = new Map<number, StoredInviteLink>()
    activeLinks.forEach((l, i) => m.set(i + 1, l))
    return m
  }, [activeLinks])

  const onGenerateLink = useCallback(
    async (slotId: number) => {
      if (!position) return
      setLoadingId(slotId)
      try {
        await inviteLinks.createLink(hop)
      } finally {
        setLoadingId(null)
      }
    },
    [position, inviteLinks, hop],
  )

  const onCopy = useCallback((slotId: number, link: string) => {
    navigator.clipboard.writeText(link).catch(() => {
      // Non-fatal — clipboard API may be unavailable in non-secure contexts.
    })
    setCopiedId(slotId)
    setTimeout(() => setCopiedId((cur) => (cur === slotId ? null : cur)), 2000)
  }, [])

  const onRevoke = useCallback(
    (slotId: number) => {
      const link = linkBySlotId.get(slotId)
      if (!link) return
      setLoadingId(slotId)
      void inviteLinks
        .revokeLink(link.nonce)
        .finally(() => setLoadingId((cur) => (cur === slotId ? null : cur)))
    },
    [linkBySlotId, inviteLinks],
  )

  const onInviteOnchain = useCallback(
    async (slotId: number, address: string, _ensName?: string) => {
      if (!signer || !crowdfundAddress) return
      setLoadingId(slotId)
      try {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
        const tx = await crowdfund.invite(address, hop)
        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          throw new Error('Transaction reverted')
        }
        // Best-effort: refresh signed-link records so any redemption that
        // landed during the tx wait surfaces. The "this user issued a direct
        // invite" slot state isn't tracked here — slot rows reflect signed
        // links only. Inflight direct invites will appear in My Position's
        // graph once the indexer picks them up.
        await inviteLinks.refreshLinks()
      } catch (err) {
        // Surface the failure to the user. Toast notifications live one layer
        // up — for now, an alert keeps the contract feedback honest.
        const message = err instanceof Error ? err.message : String(err)
        if (typeof window !== 'undefined') {
          window.alert(`On-chain invite failed: ${message}`)
        }
      } finally {
        setLoadingId(null)
      }
    },
    [hop, signer, crowdfundAddress, inviteLinks],
  )

  // Real ENS resolver — only wired when a provider is available. Falls back to
  // SlotCard's internal mock if the prop is undefined (which happens when the
  // committer is on local mode without a provider). The resolver normalises
  // success/error into SlotCardEnsResult so the controlled-mode branch in
  // SlotCard can render without owning provider semantics.
  const resolveEns = useMemo<CrowdfundInviteSlotConfig['resolveEns']>(() => {
    if (!provider) return undefined
    return async (input: string): Promise<SlotCardEnsResult> => {
      try {
        const resolved = await provider.resolveName(input)
        if (!resolved) return { error: 'ENS name not found' }
        return { address: resolved }
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : 'ENS resolution failed',
        }
      }
    }
  }, [provider])

  const config: CrowdfundInviteSlotConfig = {
    slots,
    copiedId,
    loadingId,
    onGenerateLink,
    onCopy,
    onRevoke,
    onInviteOnchain,
    resolveEns,
  }

  return {
    config,
    hopLabel,
    totalSlots,
    empty: position === null,
  }
}
