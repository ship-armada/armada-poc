// ABOUTME: Demo invite fixtures + available-count helpers for My Position / Stages.

import type { SlotData } from '../InviteFlow/screens/SlotCard'
import type { PinnedNode } from '../NodeSphere/NodeSphere'
import {
  availableForHop,
  type InviteAllowance,
  type InviteeHop,
} from './inviteModel'

export const COMMITTED = 4000
export const CAP = 10000
/** ARM allocation is 1:1 with USDC committed. */
export const ARM_ALLOCATION = COMMITTED
export const FILL_PCT = (COMMITTED / CAP) * 100

export function formatUsdcCommitted(value: number = COMMITTED): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

export function formatArmAllocation(value: number = ARM_ALLOCATION): string {
  return value.toLocaleString('en-US')
}
export const GRAPH_SEED = 42
export const GRAPH_PARTICIPANTS = 5 as const
export const DEMO_WALLET = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a3c'
export const DEMO_WALLET_DISPLAY = '0x1a2b...9a3c'

/**
 * Demo allowance: hop-0 (3→Hop-1) + 2 hop-1 positions (4→Hop-2).
 * Max theoretical is 3 + 20; this fixture stays smaller for the gallery.
 */
export const DEMO_INVITE_ALLOWANCE: InviteAllowance = {
  hop1: 3,
  hop2: 4,
}

/** Empty invite slots still available across hops (legacy header count). */
export function countAvailableInviteSlots(
  invites: SlotData[],
  allowance: InviteAllowance = DEMO_INVITE_ALLOWANCE,
): number {
  return (['1', '2'] as const).reduce((sum, key) => {
    const hop = Number(key) as InviteeHop
    return sum + availableForHop(invites, allowance, hop)
  }, 0)
}

export const DEMO_SLOTS: SlotData[] = [
  {
    id: 1,
    status: 'link-active',
    link: 'https://armada.wtf/join?invite=y2kh71abc&hop=hop-1',
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    inviteeHop: 1,
    invitedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
  },
  {
    id: 2,
    status: 'onchain-pending',
    invitedAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    ensName: 'vitalik.eth',
    inviteeHop: 1,
    invitedAt: new Date('2026-03-10T12:00:00Z'),
  },
  {
    id: 3,
    status: 'redeemed',
    redeemedBy: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    joinedAt: new Date('2026-03-12T14:00:00Z'),
    inviteeHop: 2,
    invitedAt: new Date('2026-03-11T10:00:00Z'),
  },
  {
    id: 4,
    status: 'expired',
    link: 'https://armada.wtf/join?invite=expired99&hop=hop-1',
    expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    closedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    inviteeHop: 1,
    invitedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  },
  {
    id: 5,
    status: 'revoked',
    link: 'https://armada.wtf/join?invite=revoked01&hop=hop-2',
    closedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    inviteeHop: 2,
    invitedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  },
  {
    id: 6,
    status: 'redeemed',
    redeemedBy: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
    joinedAt: new Date('2026-03-08T09:00:00Z'),
    inviteeHop: 2,
    invitedAt: new Date('2026-03-07T09:00:00Z'),
  },
]

/**
 * Graph pins for My Position / crowdfund.
 * Self-fill redemptions (redeemedBy === self) are omitted — POC merges those into one
 * wallet node (NodeSphere “Your wallet”), not N duplicate invitee pins.
 * Multi-hop is shown via hop label / list; the sphere keeps one Your-wallet pin with the total.
 */
export function buildInvitePinnedNodes(
  slots: SlotData[],
  walletAddress: string,
  committedUsdc: number,
): PinnedNode[] {
  const self = walletAddress.toLowerCase()
  const nodes: PinnedNode[] = [
    {
      kind: 'Your wallet',
      address: walletAddress,
      committed:
        committedUsdc > 0
          ? `$${committedUsdc.toLocaleString()} committed`
          : '$0 committed',
    },
  ]

  for (const slot of slots) {
    if (slot.status === 'redeemed' && slot.redeemedBy) {
      if (slot.redeemedBy.toLowerCase() === self) continue
      nodes.push({
        kind: slot.inviteeHop === 2 ? 'Hop 2' : 'Hop 1',
        address: slot.redeemedBy,
        committed: 'Joined',
      })
    } else if (slot.status === 'onchain-pending' && slot.invitedAddress) {
      if (slot.invitedAddress.toLowerCase() === self) continue
      nodes.push({
        kind: slot.inviteeHop === 2 ? 'Hop 2' : 'Hop 1',
        address: slot.invitedAddress,
        committed: 'Pending invite',
      })
    }
  }

  return nodes
}
