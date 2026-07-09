// ABOUTME: S-M4 tests for the shield handler's direct submit path — markWaiting before each wallet
// ABOUTME: prompt ("Confirm in your wallet" reachable) + approveTxHash/approveSkipped artifacts written.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const wagmi = vi.hoisted(() => ({
  // Default allowance is overridden per-test.
  readContract: vi.fn(async () => 0n),
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

const simulateMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/tx/simulate', () => ({ simulateOrThrow: simulateMock }))

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => false,
  getWalletId: () => 'rw-1',
  getRailgunAddress: () => '0zk1example',
}))

import { maxUint256 } from 'viem'
import { shieldHandler } from './handler'
import type { ExecutorCtx } from '@/lib/tx/executor'
import type { TxRecord } from '@/lib/tx/types'

function makeCtx() {
  const upserts: TxRecord[] = []
  const upsert = vi.fn(async (r: TxRecord) => { upserts.push(r) })
  const ac = new AbortController()
  const ctx = { signal: ac.signal, upsert } as unknown as ExecutorCtx<'shield'>
  return { ctx, upserts, upsert }
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
        npk: `0x${'00'.repeat(32)}`,
        value: '1000000',
        encryptedBundle: [`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`],
        shieldKey: `0x${'00'.repeat(32)}`,
      },
    },
    walletContext: { evmAddress: '0xabc', railgunWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'shield'>
}

/** Global invocation order of the call that wrote a `waiting` upsert with the matching stage. */
function waitingOrder(upsert: ReturnType<typeof vi.fn>): number | undefined {
  const idx = upsert.mock.calls.findIndex(
    ([r]) => (r as TxRecord).executionState === 'waiting' && (r as TxRecord).stage === 'submit-relayer',
  )
  return idx === -1 ? undefined : upsert.mock.invocationCallOrder[idx]
}

describe('shieldHandler direct submit wallet steps (S-M4)', () => {
  beforeEach(() => {
    wagmi.readContract.mockReset().mockResolvedValue(0n)
    wagmi.writeContract.mockReset().mockResolvedValue('0xshieldhash')
    ensureChainMock.mockClear()
    waitForReceiptMock.mockClear()
    simulateMock.mockClear()
  })

  it('allowance sufficient: marks approveSkipped + a waiting state before the shield prompt', async () => {
    wagmi.readContract.mockResolvedValue(maxUint256) // approve not needed
    const { ctx, upserts, upsert } = makeCtx()
    await shieldHandler.run(freshShieldRecord(), ctx)

    // Approve recorded as skipped so the wallet-step list omits the Approve row.
    expect(upserts.some(u => (u.artifacts as { approveSkipped?: boolean }).approveSkipped === true)).toBe(true)
    // "Confirm in your wallet" is reachable: a waiting state is written at submit-relayer...
    const wOrder = waitingOrder(upsert)
    expect(wOrder).toBeDefined()
    // ...before the shield broadcast prompt.
    expect(wOrder!).toBeLessThan(wagmi.writeContract.mock.invocationCallOrder[0]!)
    // Still finalizes correctly.
    expect(upserts.at(-1)?.stage).toBe('hub-confirmed')
    expect(upserts.at(-1)?.executionState).toBe('completed')
  })

  it('allowance low: writes approveTxHash and marks waiting before the approve prompt', async () => {
    wagmi.readContract.mockResolvedValue(0n) // approve needed
    wagmi.writeContract
      .mockResolvedValueOnce('0xapprovehash') // approve
      .mockResolvedValueOnce('0xshieldhash')  // shield
    const { ctx, upserts, upsert } = makeCtx()
    await shieldHandler.run(freshShieldRecord(), ctx)

    expect(upserts.some(u => (u.artifacts as { approveTxHash?: string }).approveTxHash === '0xapprovehash')).toBe(true)
    // The first waiting state precedes the first (approve) write.
    expect(waitingOrder(upsert)!).toBeLessThan(wagmi.writeContract.mock.invocationCallOrder[0]!)
    // Two wallet prompts → at least two waiting states.
    const waitingCount = upsert.mock.calls.filter(([r]) => (r as TxRecord).executionState === 'waiting').length
    expect(waitingCount).toBeGreaterThanOrEqual(2)
    expect(upserts.at(-1)?.executionState).toBe('completed')
  })
})
