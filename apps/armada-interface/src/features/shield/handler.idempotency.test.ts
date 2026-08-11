// ABOUTME: Idempotency tests for the shield handler's submit stage (P0-1 / WS1.3).
// ABOUTME: A record re-entering submit-relayer with a sourceTxHash must NOT re-broadcast — it resumes via the receipt wait.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// writeContract / readContract / sendTransaction must NEVER fire on a re-entry that already has a
// hash — a second shield is a second real deposit. These throw to fail the test loudly if called.
const wagmi = vi.hoisted(() => ({
  writeContract: vi.fn(() => { throw new Error('writeContract must not be called on idempotent re-entry') }),
  readContract: vi.fn(() => { throw new Error('readContract must not be called on idempotent re-entry') }),
  sendTransaction: vi.fn(() => { throw new Error('sendTransaction must not be called on idempotent re-entry') }),
}))
vi.mock('wagmi/actions', () => wagmi)

// Stub the wagmi config so importing the handler doesn't spin up WalletConnect/Lit in the test env.
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))

const ensureChainMock = vi.hoisted(() => vi.fn(() => { throw new Error('ensureChain must not be called on idempotent re-entry') }))
vi.mock('@/lib/network-switch', () => ({ ensureChain: ensureChainMock }))

const waitForReceiptMock = vi.hoisted(() => vi.fn(async () => ({ status: 'success' })))
vi.mock('@/lib/tx/receipt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/receipt')>()
  return { ...actual, waitForReceiptOrFail: waitForReceiptMock }
})

vi.mock('@/lib/shielded/keyManager', () => ({
  // isUnlocked false → handler skips the post-confirm balance refresh (keeps the test self-contained).
  isUnlocked: () => false,
  getWalletId: () => 'rw-1',
  getShieldedAddress: () => '0zk1example',
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
  return { ctx, upserts, ac }
}

function shieldRecordWithHash(): TxRecord<'shield'> {
  return {
    id: 'ulid-shield-resume',
    kind: 'shield',
    executionState: 'retrying',
    stage: 'submit-relayer',
    stagesCompleted: ['build-proof'],
    updatedSeq: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    meta: { amount: 1_000_000n, feeCacheId: 'c', fromChainId: 31337, useGasless: false },
    artifacts: {
      sourceTxHash: '0xfeed',
      privacyPoolAddress: '0x1111111111111111111111111111111111111111',
      usdcAddress: '0x2222222222222222222222222222222222222222',
      shieldRequest: {
        npk: '0x00',
        value: '1000000',
        encryptedBundle: ['0x00', '0x00', '0x00'],
        shieldKey: '0x00',
      },
    },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

describe('shieldHandler submit idempotency (P0-1 direct path)', () => {
  beforeEach(() => {
    wagmi.writeContract.mockClear()
    wagmi.readContract.mockClear()
    wagmi.sendTransaction.mockClear()
    ensureChainMock.mockClear()
    waitForReceiptMock.mockClear()
  })

  it('skips re-broadcast when a sourceTxHash already exists and finalizes via the receipt wait', async () => {
    const { ctx, upserts } = makeCtx()
    await shieldHandler.run(shieldRecordWithHash(), ctx)

    // No broadcast of any kind — the funds-critical guarantee.
    expect(wagmi.writeContract).not.toHaveBeenCalled()
    expect(wagmi.sendTransaction).not.toHaveBeenCalled()
    expect(ensureChainMock).not.toHaveBeenCalled()
    // It advanced via the receipt path.
    expect(waitForReceiptMock).toHaveBeenCalledOnce()
    const last = upserts.at(-1)
    expect(last?.stage).toBe('hub-confirmed')
    expect(last?.executionState).toBe('completed')
    expect(last?.artifacts.sourceTxHash).toBe('0xfeed')
  })
})
