// ABOUTME: Derives one CrowdfundInviteSlotSection per eligible hop from useInviteLinks + eligibility state.
// ABOUTME: Single-source-of-truth adapter consumed by both inline (MyPosition view) and standalone (Invite Slots page) surfaces; multi-hop wallets get multiple sections.

import { useCallback, useMemo, useState } from 'react'
import { Contract, type JsonRpcProvider, type Signer } from 'ethers'
import { toast } from 'sonner'
import { encodeInviteUrl, type StoredInviteLink } from '@/lib/inviteLinks'
import { TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE, isTxTimeoutError } from '@/lib/txWait'
import { mapRevertToMessage } from '@/lib/revertMessages'
import {
  CROWDFUND_ABI_FRAGMENTS,
  HOP_CONFIGS,
  hopPillDotColor,
  truncateAddress,
  useENS,
  type CrowdfundEvent,
  type CrowdfundInviteSlotConfig,
  type CrowdfundInviteSlotSection,
  type ReceiptLogLike,
  type SlotCardEnsResult,
  type SlotData,
} from '@armada/crowdfund-shared'
import type { HopPosition } from '@/hooks/useEligibility'
import type { UseInviteLinksResult } from '@/hooks/useInviteLinks'

export interface UseInviteSlotsResult {
  /** One section per eligible hop. Multi-hop wallets carry two/three; single
   *  hop wallets carry one. Empty array when the wallet isn't eligible at
   *  any hop. */
  sections: CrowdfundInviteSlotSection[]
  /** True when the wallet has no eligibility positions at all; consumers
   *  short-circuit to a "no invite slots" message rather than rendering an
   *  empty section list. */
  empty: boolean
}

const HOP_LABELS = ['SEED', 'HOP-1', 'HOP-2'] as const
const HOP_DOT_KEYS = ['seed', 'hop-1', 'hop-2'] as const

/** Map an `HopPosition` plus its slot UI to one `CrowdfundInviteSlotSection`.
 *  Used by the public `useInviteSlots` hook below — extracted so the hook
 *  reads as a flat reducer over `positions` rather than an N-way branch.
 *
 *  Slot IDs are assigned globally 1..N across the wallet's full invite set,
 *  with `startId` provided by the parent so the shared `copiedId` /
 *  `loadingId` numeric state never collides across sections. */
function useHopSection(args: {
  position: HopPosition
  /** First slot ID for this section. The parent computes startId per hop
   *  from the cumulative slot count of preceding hops so the wallet's full
   *  set is numbered 1..N globally. */
  startId: number
  inviteLinks: UseInviteLinksResult
  signer: Signer | null
  crowdfundAddress: string | null
  address: string | null
  events: CrowdfundEvent[]
  copiedId: number | null
  loadingId: number | null
  setCopiedId: React.Dispatch<React.SetStateAction<number | null>>
  setLoadingId: React.Dispatch<React.SetStateAction<number | null>>
  resolveEns: CrowdfundInviteSlotConfig['resolveEns']
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void
}): CrowdfundInviteSlotSection {
  const {
    position,
    startId,
    inviteLinks,
    signer,
    crowdfundAddress,
    address,
    events,
    copiedId,
    loadingId,
    setCopiedId,
    setLoadingId,
    resolveEns,
    onReceiptLogs,
  } = args

  const hop = position.hop
  // Total slot budget for this hop = `invitesReceived * maxInvites[hop]`.
  // We compute it from the canonical `HOP_CONFIGS` rather than reading
  // `position.invitesAvailable + position.invitesUsed`, because the graph's
  // `invitesAvailable` is initialized once at node-creation time and never
  // bumped when the wallet is invited into the same hop a second time —
  // so multi-invite hops would otherwise under-report their slot count.
  const perInviteSlots = hop < HOP_CONFIGS.length ? HOP_CONFIGS[hop].maxInvites : 0
  const totalSlots = position.invitesReceived * perInviteSlots

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
  // (nonce = 0). Split per-hop so each section drives its own slot state.
  const { directInvitedAddresses, linkRedemptions } = useMemo<{
    directInvitedAddresses: string[]
    linkRedemptions: Map<number, string>
  }>(() => {
    const directs: string[] = []
    const redemptions = new Map<number, string>()
    if (!address) return { directInvitedAddresses: directs, linkRedemptions: redemptions }
    const lowerAddr = address.toLowerCase()
    const targetHop = hop + 1
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
  }, [events, address, hop])

  // Build visible slot rows. Slot IDs run globally 1..N across all the
  // wallet's sections — `startId` is supplied by the parent based on the
  // cumulative slot count of preceding hops, so the shared copiedId /
  // loadingId state never collides across sections.
  const slots = useMemo<SlotData[]>(() => {
    const out: SlotData[] = []
    const linkRowsUsed = Math.min(activeLinks.length, totalSlots)
    for (let i = 0; i < linkRowsUsed; i += 1) {
      const slotId = startId + i
      const link = activeLinks[i]
      const redeemedBy = linkRedemptions.get(link.nonce)
      if (redeemedBy) {
        out.push({ id: slotId, status: 'redeemed', redeemedBy })
        continue
      }
      if (link.status === 'redeemed') {
        out.push({ id: slotId, status: 'redeemed' })
        continue
      }
      out.push({
        id: slotId,
        status: 'link-active',
        link: encodeInviteUrl(link),
        expiresAt: new Date(link.deadline * 1000),
      })
    }
    let directIndex = 0
    for (let i = linkRowsUsed; i < totalSlots; i += 1) {
      const slotId = startId + i
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
  }, [totalSlots, activeLinks, directInvitedAddresses, linkRedemptions, startId])

  // Map slotId → matching link record (for revoke nonce lookup). Keyed off
  // the globally-unique slotId so the section's onRevoke can find the right
  // nonce even though the global state may hold a slotId from another hop.
  const linkBySlotId = useMemo(() => {
    const m = new Map<number, StoredInviteLink>()
    activeLinks.forEach((l, i) => m.set(startId + i, l))
    return m
  }, [activeLinks, startId])

  const onGenerateLink = useCallback(
    async (slotId: number) => {
      setLoadingId(slotId)
      try {
        await inviteLinks.createLink(hop)
      } finally {
        setLoadingId((cur) => (cur === slotId ? null : cur))
      }
    },
    [inviteLinks, hop, setLoadingId],
  )

  const onCopy = useCallback(
    (slotId: number, link: string) => {
      navigator.clipboard.writeText(link).catch(() => {
        // Non-fatal — clipboard API may be unavailable in non-secure contexts.
      })
      setCopiedId(slotId)
      setTimeout(() => setCopiedId((cur) => (cur === slotId ? null : cur)), 2000)
    },
    [setCopiedId],
  )

  const onRevoke = useCallback(
    (slotId: number) => {
      const link = linkBySlotId.get(slotId)
      if (!link) return
      setLoadingId(slotId)
      void inviteLinks
        .revokeLink(link.nonce)
        .finally(() => setLoadingId((cur) => (cur === slotId ? null : cur)))
    },
    [linkBySlotId, inviteLinks, setLoadingId],
  )

  const onInviteOnchain = useCallback(
    async (slotId: number, invitee: string, ensName?: string) => {
      if (!signer || !crowdfundAddress) return
      setLoadingId(slotId)
      try {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
        const tx = await crowdfund.invite(invitee, hop)
        const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS)
        if (!receipt || receipt.status === 0) {
          throw new Error('Transaction reverted')
        }
        if (onReceiptLogs) {
          onReceiptLogs(receipt.logs as unknown as readonly ReceiptLogLike[])
        }
        await inviteLinks.refreshLinks()
        toast.success(`Invite sent to ${ensName ?? truncateAddress(invitee)}`)
      } catch (err) {
        if (isTxTimeoutError(err)) {
          // The invite tx may still confirm — don't claim failure.
          toast.error('Invite still pending', { description: TX_PENDING_MESSAGE })
        } else {
          // Route through the revert mapper so the toast shows a friendly
          // message, not raw calldata/internal error text.
          toast.error('Invite failed', { description: mapRevertToMessage(err) })
        }
      } finally {
        setLoadingId((cur) => (cur === slotId ? null : cur))
      }
    },
    [hop, signer, crowdfundAddress, inviteLinks, onReceiptLogs, setLoadingId],
  )

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
    hop: hop as 0 | 1 | 2,
    hopLabel: HOP_LABELS[hop],
    hopColor: hopPillDotColor(HOP_DOT_KEYS[hop]),
    totalSlots,
    config,
  }
}

/**
 * Build one `CrowdfundInviteSlotSection` per eligible hop for the connected
 * wallet. Single-hop wallets get one section; multi-hop wallets get two or
 * three. Consumers render sections stacked, hiding the section header when
 * there's only one.
 *
 * Note: this hook calls `useHopSection` once per `positions[0..2]`. Since
 * hooks must be called in a stable order, the implementation iterates a
 * fixed-length `[0, 1, 2]` array of hops and includes only the sections for
 * which an eligibility position exists, satisfying React's rules of hooks.
 */
export function useInviteSlots(
  positions: HopPosition[],
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

  // Real ENS resolver — only wired when a provider is available. Falls back
  // to SlotCard's internal mock if the prop is undefined.
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

  // Build a fixed 3-slot array of HopPosition | null so we call useHopSection
  // in a stable order regardless of which hops the wallet is eligible at.
  // React's rules of hooks require the same number of hook calls per render;
  // we always call useHopSection three times and filter the result.
  const positionByHop = useMemo<(HopPosition | null)[]>(() => {
    const slots: (HopPosition | null)[] = [null, null, null]
    for (const p of positions) {
      if (p.hop === 0 || p.hop === 1 || p.hop === 2) slots[p.hop] = p
    }
    return slots
  }, [positions])

  // Per-hop starting slot ID so the wallet's full invite set is numbered
  // 1..N globally across sections. A wallet with 3 seed slots + 4 hop-1
  // slots renders SEED 1-3 and HOP-1 4-7.
  const startIdByHop = useMemo<[number, number, number]>(() => {
    const slotsPerHop = (i: 0 | 1 | 2): number => {
      const p = positionByHop[i]
      if (!p) return 0
      const per = i < HOP_CONFIGS.length ? HOP_CONFIGS[i].maxInvites : 0
      return p.invitesReceived * per
    }
    const h0 = slotsPerHop(0)
    const h1 = slotsPerHop(1)
    return [1, 1 + h0, 1 + h0 + h1]
  }, [positionByHop])

  // Stable empty position placeholder so disabled-hop hook calls receive a
  // typed `HopPosition`. The resulting section gets discarded below — we
  // only need the hook calls themselves to remain in a stable order.
  const placeholder: HopPosition = {
    hop: 0,
    invitesReceived: 0,
    committed: 0n,
    effectiveCap: 0n,
    remaining: 0n,
    invitesUsed: 0,
    invitesAvailable: 0,
    invitedBy: [],
  }

  // Three hook calls in a stable order — one per hop slot. Disabled slots get
  // the placeholder position; we filter them out of the returned array.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const section0 = useHopSection({
    position: positionByHop[0] ?? { ...placeholder, hop: 0 },
    startId: startIdByHop[0],
    inviteLinks,
    signer,
    crowdfundAddress,
    address,
    events,
    copiedId,
    loadingId,
    setCopiedId,
    setLoadingId,
    resolveEns,
    onReceiptLogs,
  })
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const section1 = useHopSection({
    position: positionByHop[1] ?? { ...placeholder, hop: 1 },
    startId: startIdByHop[1],
    inviteLinks,
    signer,
    crowdfundAddress,
    address,
    events,
    copiedId,
    loadingId,
    setCopiedId,
    setLoadingId,
    resolveEns,
    onReceiptLogs,
  })
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const section2 = useHopSection({
    position: positionByHop[2] ?? { ...placeholder, hop: 2 },
    startId: startIdByHop[2],
    inviteLinks,
    signer,
    crowdfundAddress,
    address,
    events,
    copiedId,
    loadingId,
    setCopiedId,
    setLoadingId,
    resolveEns,
    onReceiptLogs,
  })

  const rawSections = useMemo(() => {
    const all = [section0, section1, section2]
    return all.filter((_, i) => positionByHop[i] !== null)
  }, [section0, section1, section2, positionByHop])

  // Collect every address that appears in a slot row so `useENS` can issue
  // one batched reverse lookup. The hook dedupes internally; passing the
  // raw list is fine. Both `invitedAddress` (onchain-pending) and
  // `redeemedBy` (redeemed) feed into the slot display, so both go in.
  const slotAddresses = useMemo(() => {
    const out: string[] = []
    for (const section of rawSections) {
      for (const slot of section.config.slots) {
        if (slot.invitedAddress) out.push(slot.invitedAddress)
        if (slot.redeemedBy) out.push(slot.redeemedBy)
      }
    }
    return out
  }, [rawSections])

  const { resolve: resolveCachedName } = useENS({ provider, addresses: slotAddresses })

  // Enrich each slot with reverse-resolved names so the SlotCard rows can
  // render `alice.eth` instead of `0xabcd…1234`. Forward-resolved names (set
  // at invite time on the onchain-pending path) take priority over the
  // reverse lookup. Resolution that hasn't completed yet returns null and
  // the row falls back to the truncated address — re-renders naturally pick
  // up the name once react-query settles.
  const sections = useMemo<CrowdfundInviteSlotSection[]>(() => {
    return rawSections.map((section) => ({
      ...section,
      config: {
        ...section.config,
        slots: section.config.slots.map((slot) => {
          if (slot.status === 'onchain-pending' && slot.invitedAddress) {
            const ensName = slot.ensName ?? resolveCachedName(slot.invitedAddress) ?? undefined
            return ensName === slot.ensName ? slot : { ...slot, ensName }
          }
          if (slot.status === 'redeemed' && slot.redeemedBy) {
            const redeemedEnsName =
              slot.redeemedEnsName ?? resolveCachedName(slot.redeemedBy) ?? undefined
            return redeemedEnsName === slot.redeemedEnsName
              ? slot
              : { ...slot, redeemedEnsName }
          }
          return slot
        }),
      },
    }))
  }, [rawSections, resolveCachedName])

  return {
    sections,
    empty: positions.length === 0,
  }
}
