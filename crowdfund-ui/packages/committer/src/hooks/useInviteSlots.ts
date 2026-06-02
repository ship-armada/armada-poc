// ABOUTME: Derives a CrowdfundInviteSlotConfig from the committer's useInviteLinks + eligibility state.
// ABOUTME: Single-source-of-truth adapter consumed by both the inline (MyPosition view) and standalone (Invite Slots page) surfaces.

import { useCallback, useMemo, useState } from 'react'
import { Contract, type JsonRpcProvider, type Signer } from 'ethers'
import { toast } from 'sonner'
import { encodeInviteUrl, type StoredInviteLink } from '@/lib/inviteLinks'
import {
  CROWDFUND_ABI_FRAGMENTS,
  truncateAddress,
  type CrowdfundEvent,
  type CrowdfundInviteSlotConfig,
  type ReceiptLogLike,
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
  /** Connected wallet address — used to identify which on-chain invites in the
   *  event stream were issued by this user, so direct invites fill `'onchain-
   *  pending'` slot rows. */
  address: string | null,
  /** Full event stream from `useContractEvents`. We filter the `Invited`
   *  events for direct (`nonce === 0`) invites issued by `address`, so the
   *  invite slots state survives page reload — derived from chain truth, not
   *  in-flight local state. */
  events: CrowdfundEvent[],
  /** `useContractEvents.ingestReceiptLogs` — when supplied, the on-chain
   *  invite path forwards the tx receipt's logs so the graph state (and any
   *  derived UI like the multi-hop green halo on the inviter node) updates
   *  immediately instead of waiting for the next event-poll tick. */
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void,
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

  // `Invited(inviter, invitee, hop, nonce)` covers both signed-link
  // redemptions (nonce = the link's nonce) and direct `invite()` calls
  // (nonce = 0). Split the event stream by `nonce` so we can drive two
  // different slot states from the same stream:
  //   - directInvitedAddresses → ordered list of nonce=0 invitees, filling
  //     `'onchain-pending'` rows after the link rows.
  //   - linkRedemptions → map from link nonce → redeemer address, used to
  //     flip `'link-active'` rows to `'redeemed'` once on chain.
  const { directInvitedAddresses, linkRedemptions } = useMemo<{
    directInvitedAddresses: string[]
    linkRedemptions: Map<number, string>
  }>(() => {
    const directs: string[] = []
    const redemptions = new Map<number, string>()
    if (!address || !position) return { directInvitedAddresses: directs, linkRedemptions: redemptions }
    const lowerAddr = address.toLowerCase()
    const targetHop = position.hop + 1
    const matched = events
      .filter((e) => {
        if (e.type !== 'Invited') return false
        const inviter = String(e.args.inviter).toLowerCase()
        if (inviter !== lowerAddr) return false
        if (Number(e.args.hop) !== targetHop) return false
        return true
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    for (const e of matched) {
      const nonce = e.args.nonce
      const nonceNum = typeof nonce === 'bigint' ? Number(nonce) : Number(nonce)
      const invitee = String(e.args.invitee).toLowerCase()
      if (nonceNum === 0) {
        directs.push(invitee)
      } else {
        redemptions.set(nonceNum, invitee)
      }
    }
    return { directInvitedAddresses: directs, linkRedemptions: redemptions }
  }, [events, address, position])

  // Build the visible slot rows. We assign slot IDs positionally (1..N).
  // Link-active and link-redeemed rows from `activeLinks` fill first (in
  // creation order); direct on-chain invites then fill the next rows as
  // `'onchain-pending'` with the invitee address; any remaining rows stay
  // empty. We dedup by address so a wallet that was both link-redeemed and
  // later re-invited on-chain doesn't double-fill rows.
  const slots = useMemo<SlotData[]>(() => {
    const out: SlotData[] = []
    const linkRowsUsed = Math.min(activeLinks.length, totalSlots)
    for (let i = 0; i < linkRowsUsed; i += 1) {
      const slotId = i + 1
      const link = activeLinks[i]
      // Live redemption check: if there's an `Invited` event matching this
      // nonce, the link has been consumed on chain — flip to 'redeemed' even
      // if the local record still reads 'pending' (the IndexedDB status flag
      // only gets updated on revoke, never on redeem). This naturally hides
      // the Copy/Revoke buttons on redeemed links, which matters because
      // revoking a used nonce reverts at the contract level.
      const redeemedBy = linkRedemptions.get(link.nonce)
      if (redeemedBy) {
        out.push({ id: slotId, status: 'redeemed', redeemedBy })
        continue
      }
      if (link.status === 'redeemed') {
        // IndexedDB-locked fallback. Shouldn't fire post-event-fix, but
        // preserved so a stale record still renders as redeemed if events
        // haven't backfilled yet.
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
    let directIndex = 0
    for (let i = linkRowsUsed; i < totalSlots; i += 1) {
      const slotId = i + 1
      const invitedAddress = directInvitedAddresses[directIndex]
      directIndex += 1
      if (!invitedAddress) {
        out.push({ id: slotId, status: 'empty' })
        continue
      }
      out.push({
        id: slotId,
        status: 'onchain-pending',
        invitedAddress,
      })
    }
    return out
  }, [totalSlots, activeLinks, directInvitedAddresses])

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
    async (slotId: number, invitee: string, ensName?: string) => {
      if (!signer || !crowdfundAddress) return
      setLoadingId(slotId)
      try {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
        const tx = await crowdfund.invite(invitee, hop)
        const receipt = await tx.wait()
        if (!receipt || receipt.status === 0) {
          throw new Error('Transaction reverted')
        }
        // Forward receipt logs into the event stream so derived graph state
        // (NodeSphere multi-hop halo, slot rows, MyPosition tooltips) reflects
        // the new `Invited` edge immediately. Without this, the next event-poll
        // tick is the only thing that surfaces the change — which on a self-
        // invite leaves the inviter's node un-haloed until a page refresh.
        if (onReceiptLogs) {
          onReceiptLogs(receipt.logs as unknown as readonly ReceiptLogLike[])
        }
        // Refresh signed-link records so any concurrent redemption surfaces.
        await inviteLinks.refreshLinks()
        toast.success(`Invite sent to ${ensName ?? truncateAddress(invitee)}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error('Invite failed', { description: message })
      } finally {
        setLoadingId(null)
      }
    },
    [hop, signer, crowdfundAddress, inviteLinks, onReceiptLogs],
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
