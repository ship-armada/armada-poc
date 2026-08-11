// ABOUTME: Chain-pin tests for the yield-deposit handler's wallet-override submit path (W-3/W-4).
// ABOUTME: The hub-chain send + receipt wait must carry an explicit chainId so a mid-flow wallet network switch can't retarget them.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionMock = vi.hoisted(() => vi.fn(async () => '0xyielddeposithash'))
vi.mock('wagmi/actions', () => ({ sendTransaction: sendTransactionMock }))
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))

const ensureChainMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/network-switch', () => ({ ensureChain: ensureChainMock }))

const waitForReceiptMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success' })))
vi.mock('@/lib/tx/receipt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/receipt')>()
  return { ...actual, waitForReceiptOrFail: waitForReceiptMock }
})

// S-M8: the override path pre-flight-simulates before the send. Mock to no-op; asserted below.
const simulateMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: simulateMock }))

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => false,
  getWalletId: () => 'rw-1',
  getShieldedAddress: () => '0zk1example',
  getSdkEncryptionKey: () => '0xkey',
}))
vi.mock('@/lib/railgun/sync', () => ({ refreshShieldedBalances: vi.fn(async () => {}) }))

import { yieldDepositHandler } from './handler'
import type { ExecutorCtx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

function makeCtx() {
  const upserts: TxRecord[] = []
  const ac = new AbortController()
  const ctx: ExecutorCtx<'yield-deposit'> = {
    signal: ac.signal,
    upsert: async (r) => { upserts.push(r as TxRecord) },
  }
  return { ctx, upserts }
}

function freshYieldDepositRecord(): TxRecord<'yield-deposit'> {
  return {
    id: 'ulid-yield-deposit-fresh',
    kind: 'yield-deposit',
    executionState: 'active',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: { amount: 1_000_000n, feeCacheId: 'c', useWalletOverride: true },
    artifacts: {
      yieldTx: { to: '0x4444444444444444444444444444444444444444', data: '0xabcd', value: '0' },
    },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'yield-deposit'>
}

describe('yieldDepositHandler wallet-override chain pinning (W-3/W-4)', () => {
  beforeEach(() => {
    sendTransactionMock.mockClear()
    waitForReceiptMock.mockClear()
    simulateMock.mockClear()
  })

  it('pins the hub chainId on the send and the receipt wait', async () => {
    const { ctx } = makeCtx()
    await yieldDepositHandler.run(freshYieldDepositRecord(), ctx)

    expect(sendTransactionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chainId: 31337 }),
    )
    expect(waitForReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 31337 }),
    )
  })

  it('pre-flight-simulates the send (pinned) before broadcasting it (S-M8)', async () => {
    const { ctx } = makeCtx()
    await yieldDepositHandler.run(freshYieldDepositRecord(), ctx)
    expect(simulateMock).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 31337, account: '0xabc', value: 0n }),
    )
    expect(simulateMock.mock.invocationCallOrder[0]!).toBeLessThan(
      sendTransactionMock.mock.invocationCallOrder[0]!,
    )
  })
})
