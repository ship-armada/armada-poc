// ABOUTME: Chain-pin tests for the shield handler's direct submit path (W-3/W-4).
// ABOUTME: Every submit-path read/write/receipt must carry an explicit chainId so a mid-flow wallet network switch can't retarget them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { maxUint256 } from 'viem'

// Fresh-submit mocks: capture the chainId each wagmi call receives.
const wagmi = vi.hoisted(() => ({
  readContract: vi.fn(async () => maxUint256), // allowance >= amount → approve skipped
  writeContract: vi.fn(async () => '0xshieldhash'),
  sendTransaction: vi.fn(async () => '0xunused'),
}))
vi.mock('wagmi/actions', () => wagmi)
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))

const ensureChainMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/network-switch', () => ({ ensureChain: ensureChainMock }))

const waitForReceiptMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success' })))
vi.mock('@/lib/tx/receipt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/receipt')>()
  return { ...actual, waitForReceiptOrFail: waitForReceiptMock }
})

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => false, // skip the post-confirm balance refresh
  getWalletId: () => 'rw-1',
  getRailgunAddress: () => '0zk1example',
}))

import { shieldHandler } from './handler'
import type { ExecutorCtx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

function makeCtx() {
  const upserts: TxRecord[] = []
  const ac = new AbortController()
  const ctx: ExecutorCtx<'shield'> = {
    signal: ac.signal,
    upsert: async (r) => { upserts.push(r as TxRecord) },
  }
  return { ctx, upserts }
}

function freshShieldRecord(): TxRecord<'shield'> {
  return {
    id: 'ulid-shield-fresh',
    kind: 'shield',
    executionState: 'active',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337, useGasless: false },
    artifacts: {
      privacyPoolAddress: '0x1111111111111111111111111111111111111111',
      usdcAddress: '0x2222222222222222222222222222222222222222',
      shieldRequest: {
        npk: '0x00',
        value: '1000000',
        encryptedBundle: ['0x00', '0x00', '0x00'],
        shieldKey: '0x00',
      },
    },
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

describe('shieldHandler direct submit chain pinning (W-3/W-4)', () => {
  beforeEach(() => {
    wagmi.readContract.mockClear()
    wagmi.writeContract.mockClear()
    waitForReceiptMock.mockClear()
  })

  it('pins fromChainId on the allowance read, the shield write, and the receipt wait', async () => {
    const { ctx } = makeCtx()
    await shieldHandler.run(freshShieldRecord(), ctx)

    expect(wagmi.readContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chainId: 31337 }),
    )
    expect(wagmi.writeContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chainId: 31337, functionName: 'shield' }),
    )
    expect(waitForReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 31337 }),
    )
  })
})
