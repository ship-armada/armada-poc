// ABOUTME: Tests for useInviteLinks' on-chain link revocation outcome reporting.
// ABOUTME: revokeLink must resolve true only for a confirmed revoke on the hub chain, never a wrong-chain "success".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Signer } from 'ethers'

const { mockRevoke, mockToast, mockUpdateStatus } = vi.hoisted(() => ({
  mockRevoke: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  mockUpdateStatus: vi.fn(),
}))

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>()
  return {
    ...actual,
    Contract: class {
      revokeInviteNonce = mockRevoke
    },
  }
})

vi.mock('sonner', () => ({ toast: mockToast }))

vi.mock('@/lib/inviteLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inviteLinks')>()
  return {
    ...actual,
    getStoredInviteLinks: vi.fn().mockResolvedValue([]),
    updateInviteLinkStatus: mockUpdateStatus,
  }
})

import { getHubChainId } from '@/config/network'
import { useInviteLinks } from './useInviteLinks'

const WALLET = '0x2222222222222222222222222222222222222222'
const CROWDFUND = '0x3333333333333333333333333333333333333333'
const NONCE = 7

/** A signer whose wallet reports `chainId` live via `eth_chainId`. */
function signerOnChain(chainId: number): Signer {
  return { provider: { send: vi.fn().mockResolvedValue('0x' + chainId.toString(16)) } } as unknown as Signer
}

async function revoke(signer: Signer) {
  const { result } = renderHook(() => useInviteLinks(WALLET, signer, CROWDFUND, 0))
  await waitFor(() => expect(result.current.loading).toBe(false))
  let revoked: boolean | undefined
  await act(async () => {
    revoked = await result.current.revokeLink(NONCE)
  })
  return revoked
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useInviteLinks revokeLink', () => {
  it('resolves true once the revoke tx is confirmed on the hub chain', async () => {
    mockRevoke.mockResolvedValue({ wait: vi.fn().mockResolvedValue({ status: 1, logs: [] }) })
    expect(await revoke(signerOnChain(getHubChainId()))).toBe(true)
    expect(mockRevoke).toHaveBeenCalledWith(NONCE)
    expect(mockUpdateStatus).toHaveBeenCalledWith(WALLET.toLowerCase(), NONCE, 'revoked')
  })

  it('resolves false without sending when the wallet is on another chain', async () => {
    expect(await revoke(signerOnChain(getHubChainId() + 1))).toBe(false)
    expect(mockRevoke).not.toHaveBeenCalled()
    expect(mockUpdateStatus).not.toHaveBeenCalled()
    expect(mockToast.error).toHaveBeenCalledWith('Could not revoke invite', expect.anything())
  })
})
