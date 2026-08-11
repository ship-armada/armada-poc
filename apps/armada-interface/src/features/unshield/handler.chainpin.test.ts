// ABOUTME: Chain-pin tests for the unshield-local handler's wallet-override submit path (W-3/W-4).
// ABOUTME: The hub-chain receipt wait must carry an explicit chainId so a mid-flow wallet network switch can't retarget polling to a chain where the hash doesn't exist.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('wagmi/actions', () => ({ sendTransaction: vi.fn(async () => '0xunused') }))
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/network-switch', () => ({ ensureChain: vi.fn(async () => {}) }))

const waitForReceiptMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success' })))
vi.mock('@/lib/tx/receipt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/receipt')>()
  return { ...actual, waitForReceiptOrFail: waitForReceiptMock }
})

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => true, // handler guards on this before submit; refreshShieldedBalances is mocked
  getWalletId: () => 'rw-1',
  getSdkEncryptionKey: () => '0xkey',
}))
vi.mock('@/lib/railgun/sync', () => ({ refreshShieldedBalances: vi.fn(async () => {}) }))

import { unshieldLocalHandler } from './handler'
import type { ExecutorCtx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

function makeCtx() {
  const upserts: TxRecord[] = []
  const ac = new AbortController()
  const ctx: ExecutorCtx<'unshield-local'> = {
    signal: ac.signal,
    upsert: async (r) => { upserts.push(r as TxRecord) },
  }
  return { ctx, upserts }
}

function overrideRecordWithHash(): TxRecord<'unshield-local'> {
  return {
    id: 'ulid-unshield-override',
    kind: 'unshield-local',
    executionState: 'retrying',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: {
      amount: 1_000_000n,
      feeCacheId: 'c',
      recipient: '0x3333333333333333333333333333333333333333',
      broadcasterFeeAmount: 0n,
      broadcasterShieldedAddress: '0zk1relayer',
      useWalletOverride: true,
    },
    artifacts: { sourceTxHash: '0xfeed' },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'unshield-local'>
}

describe('unshieldLocalHandler wallet-override chain pinning (W-3/W-4)', () => {
  beforeEach(() => { waitForReceiptMock.mockClear() })

  it('pins the hub chainId on the receipt wait', async () => {
    const { ctx } = makeCtx()
    await unshieldLocalHandler.run(overrideRecordWithHash(), ctx)
    expect(waitForReceiptMock).toHaveBeenCalledWith(expect.objectContaining({ chainId: 31337 }))
  })
})
