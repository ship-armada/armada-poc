// ABOUTME: Idempotency tests for the unshield-local handler's relayer submit stage (P0-1 / WS1.3).
// ABOUTME: A record re-entering submit-relayer with a sourceTxHash must NOT re-POST to the relayer — it resumes via the status poll.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionMock = vi.hoisted(() => vi.fn(() => { throw new Error('sendTransaction must not be called on idempotent re-entry') }))
vi.mock('wagmi/actions', () => ({ sendTransaction: sendTransactionMock }))
vi.mock('@/config/wagmi', () => ({ wagmiConfig: {} }))

// submitRelay must NEVER fire on a re-entry that already has a hash (a duplicate 409s + re-burns).
const submitRelayMock = vi.hoisted(() => vi.fn(() => { throw new Error('submitRelay must not be called on idempotent re-entry') }))
vi.mock('@/lib/relayer', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/relayer')>()
  return { ...actual, submitRelay: submitRelayMock }
})

// The SDK unshield builder must NOT run on a submit re-entry — the calldata was stashed in build-proof.
const buildUnshieldMock = vi.hoisted(() => vi.fn(() => { throw new Error('buildUnshieldSdk must not be called on idempotent re-entry') }))
vi.mock('@/lib/railgun/unshield-sdk', () => ({ buildUnshieldSdk: buildUnshieldMock }))

const pollMock = vi.hoisted(() => vi.fn(async () => ({ status: 'done' as const, value: { status: 'confirmed' as const } })))
const pollStatusOnceMock = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@/lib/tx/poller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/tx/poller')>()
  return { ...actual, poll: pollMock, pollRelayStatusOnce: pollStatusOnceMock }
})

vi.mock('@/lib/railgun/keyManager', () => ({
  isUnlocked: () => true,
  getWalletId: () => 'rw-1',
}))

// Stub the post-confirm balance refresh — fire-and-forget, irrelevant to the idempotency assertion.
vi.mock('@/lib/railgun/sync', () => ({ refreshShieldedBalances: vi.fn(async () => {}) }))

vi.mock('@/lib/network-switch', () => ({
  ensureChain: vi.fn(() => { throw new Error('ensureChain must not be called on idempotent re-entry') }),
}))

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

function unshieldRecordWithHash(): TxRecord<'unshield-local'> {
  return {
    id: 'ulid-unshield-resume',
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
      useWalletOverride: false,
    },
    artifacts: { sourceTxHash: '0xfeed' },
    walletContext: { evmAddress: '0xabc', shieldedWalletId: 'rw-1', sourceChainId: 31337 },
  } as TxRecord<'unshield-local'>
}

describe('unshieldLocalHandler submit idempotency (P0-1 relayer path)', () => {
  beforeEach(() => {
    sendTransactionMock.mockClear()
    submitRelayMock.mockClear()
    buildUnshieldMock.mockClear()
    pollMock.mockClear()
  })

  it('skips re-POST when a sourceTxHash already exists and resumes via the status poll', async () => {
    const { ctx, upserts } = makeCtx()
    await unshieldLocalHandler.run(unshieldRecordWithHash(), ctx)

    // No re-broadcast, no re-prove.
    expect(submitRelayMock).not.toHaveBeenCalled()
    expect(sendTransactionMock).not.toHaveBeenCalled()
    expect(buildUnshieldMock).not.toHaveBeenCalled()
    // It resumed via the relayer status poll and completed.
    expect(pollMock).toHaveBeenCalledOnce()
    const last = upserts.at(-1)
    expect(last?.stage).toBe('hub-confirmed')
    expect(last?.executionState).toBe('completed')
    expect(last?.artifacts.sourceTxHash).toBe('0xfeed')
  })
})
