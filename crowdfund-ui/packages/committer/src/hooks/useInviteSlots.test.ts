// ABOUTME: Tests for useInviteSlots' on-chain invite handler outcome reporting.
// ABOUTME: onInviteOnchain must resolve true only for a confirmed invite so the UI never shows a false success.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Signer } from 'ethers'
import type { CrowdfundEvent } from '@armada/crowdfund-shared'

const { mockInvite, mockToast } = vi.hoisted(() => ({
  mockInvite: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class {
      invite = mockInvite
    },
  }
})

vi.mock('sonner', () => ({ toast: mockToast }))

import { getHubChainId } from '@/config/network'
import { useInviteSlots } from './useInviteSlots'
import type { HopPosition } from './useEligibility'
import type { UseInviteLinksResult } from './useInviteLinks'

const INVITEE = '0x1111111111111111111111111111111111111111'
const WALLET = '0x2222222222222222222222222222222222222222'
const CROWDFUND = '0x3333333333333333333333333333333333333333'

const hop0Position: HopPosition = {
  hop: 0,
  invitesReceived: 1,
  committed: 0n,
  effectiveCap: 0n,
  remaining: 0n,
  invitesUsed: 0,
  invitesAvailable: 3,
  invitedBy: [],
}

function makeInviteLinks(): UseInviteLinksResult {
  return {
    links: [],
    loading: false,
    createLink: vi.fn(),
    revokeLink: vi.fn(),
    refreshLinks: vi.fn().mockResolvedValue(undefined),
  }
}

/** A signer whose wallet reports `chainId` live via `eth_chainId`. */
function signerOnChain(chainId: number): Signer {
  return { provider: { send: vi.fn().mockResolvedValue('0x' + chainId.toString(16)) } } as unknown as Signer
}

function renderSection({
  isWrongNetwork = false,
  events = [],
  signer = {} as Signer,
}: { isWrongNetwork?: boolean; events?: CrowdfundEvent[]; signer?: Signer } = {}) {
  const switchNetwork = vi.fn()
  // useENS reads via react-query — fresh client per render so caches don't leak.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(
    () =>
      useInviteSlots(
        [hop0Position],
        makeInviteLinks(),
        null,
        signer,
        CROWDFUND,
        WALLET,
        events,
        isWrongNetwork,
        switchNetwork,
      ),
    { wrapper },
  )
  return { section: result.current.sections[0], switchNetwork }
}

async function sendInvite(section: ReturnType<typeof renderSection>['section']) {
  let sent: boolean | undefined
  await act(async () => {
    sent = await section.config.onInviteOnchain(1, INVITEE)
  })
  return sent
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useInviteSlots onInviteOnchain', () => {
  it('resolves true once the invite tx is confirmed', async () => {
    mockInvite.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
    })
    const { section } = renderSection()
    expect(await sendInvite(section)).toBe(true)
    expect(mockInvite).toHaveBeenCalledWith(INVITEE, 0)
    expect(mockToast.success).toHaveBeenCalledOnce()
  })

  it('resolves false when the wallet rejects the invite', async () => {
    mockInvite.mockRejectedValue(
      Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' }),
    )
    const { section } = renderSection()
    expect(await sendInvite(section)).toBe(false)
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('Invite failed', expect.anything())
  })

  it('resolves false when the invite tx reverts', async () => {
    mockInvite.mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ status: 0, logs: [] }),
    })
    const { section } = renderSection()
    expect(await sendInvite(section)).toBe(false)
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it('resolves false without sending when the wallet switched chains after the network check', async () => {
    // The wallet state still says hub (isWrongNetwork false), but the live chain differs.
    const { section } = renderSection({ signer: signerOnChain(getHubChainId() + 1) })
    expect(await sendInvite(section)).toBe(false)
    expect(mockInvite).not.toHaveBeenCalled()
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('Invite failed', expect.anything())
  })

  it('resolves false without sending on the wrong network', async () => {
    const { section, switchNetwork } = renderSection({ isWrongNetwork: true })
    expect(await sendInvite(section)).toBe(false)
    expect(mockInvite).not.toHaveBeenCalled()
    expect(switchNetwork).toHaveBeenCalledOnce()
  })
})

function event(type: CrowdfundEvent['type'], logIndex: number, args: Record<string, unknown>): CrowdfundEvent {
  return { type, blockNumber: 10, transactionHash: '0x' + logIndex, logIndex, args }
}

// WALLET is hop-0, so its direct invitees join at hop 1.
const directInvite = event('Invited', 0, { inviter: WALLET, invitee: INVITEE, hop: 1n, nonce: 0n })

describe('useInviteSlots direct-invite rows', () => {
  it('shows a direct invitee as waiting until they commit', () => {
    const { section } = renderSection({ events: [directInvite] })
    expect(section.config.slots[0]).toMatchObject({ status: 'onchain-pending', invitedAddress: INVITEE })
  })

  it('shows a direct invitee as joined once they commit at the invitee hop', () => {
    const committed = event('Committed', 1, { participant: INVITEE, hop: 1n, amount: 500_000_000n })
    const { section } = renderSection({ events: [directInvite, committed] })
    expect(section.config.slots[0]).toMatchObject({ status: 'redeemed', redeemedBy: INVITEE })
  })

  it('ignores the invitee committing at a different hop', () => {
    const committedElsewhere = event('Committed', 1, { participant: INVITEE, hop: 2n, amount: 500_000_000n })
    const { section } = renderSection({ events: [directInvite, committedElsewhere] })
    expect(section.config.slots[0].status).toBe('onchain-pending')
  })
})
